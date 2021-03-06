import { Invo, Lock, Paym, User } from '../class/';
import Frisbee from 'frisbee';

const express = require('express');
const config = require('../config');
const router = express.Router();
const logger = require('../utils/logger');
const MIN_BTC_BLOCK = 550000;

const Redis = require('ioredis');
const redis = new Redis(config.redisUri);
redis.monitor(function (err, monitor) {
  monitor.on('monitor', function (time, args, source, database) {
    // console.log('REDIS', JSON.stringify(args));
  });
});

let lightning = require('../lightning');
let identity_pubkey = false;
// ###################### SMOKE TESTS ########################
lightning.getInfo({}, function (err, info) {
  if (err) {
    console.error('lnd failure');
    console.dir(err);
    process.exit(3);
  }
  if (info) {
    console.info(info);
    if (!info.testnet && info.block_height < MIN_BTC_BLOCK) {
      console.error('BTC Node is not caught up');
      process.exit(1);
    }
    if (!info.synced_to_chain) {
      console.error('lnd not synced');
      process.exit(4);
    }
    identity_pubkey = info.identity_pubkey;
  }
});

redis.info(function (err, info) {
  if (err || !info) {
    console.error('redis failure');
    process.exit(5);
  }
});

const subscribeInvoicesCallCallback = async function (response) {
  if (response.state === 'SETTLED') {
    const LightningInvoiceSettledNotification = {
      memo: response.memo,
      preimage: response.r_preimage.toString('hex'),
      hash: response.r_hash.toString('hex'),
      amt_paid_sat: response.value_msat ? Math.floor(response.value_msat / 1000) : response.value,
    };
    // obtaining a lock, to make sure we push to groundcontrol only once
    // since this web server can have several instances running, and each will get the same callback from LND
    // and dont release the lock - it will autoexpire in a while
    let lock = new Lock(redis, 'groundcontrol_hash_' + LightningInvoiceSettledNotification.hash);
    if (!(await lock.obtainLock())) {
      return;
    }
    let invoice = new Invo(redis, lightning);
    await invoice._setIsPaymentHashPaidInDatabase(LightningInvoiceSettledNotification.hash, true);
    const user = new User(redis, lightning);
    user._userid = await user.getUseridByPaymentHash(LightningInvoiceSettledNotification.hash);
    await user.clearBalanceCache();
    console.log('payment', LightningInvoiceSettledNotification.hash, 'was paid, posting to GroundControl...');
    const baseURI = config.groundControlUrl;
    if (!baseURI) return;
    const _api = new Frisbee({ baseURI: baseURI });
    const apiResponse = await _api.post(
      '/lightningInvoiceGotSettled',
      Object.assign(
        {},
        {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
          },
          body: LightningInvoiceSettledNotification,
        },
      ),
    );
    console.log('GroundControl:', apiResponse.originalResponse.status);
  }
};

let subscribeInvoicesCall = lightning.subscribeInvoices({});
subscribeInvoicesCall.on('data', subscribeInvoicesCallCallback);
subscribeInvoicesCall.on('status', function (status) {
  // The current status of the stream.
});
subscribeInvoicesCall.on('end', function () {
  // The server has closed the stream.
});

// ######################## ROUTES ########################

const rateLimit = require('express-rate-limit');
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});

const authenticator = async (req, res, next) => {
  let u = new User(redis, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  req.user = u;
  next();
};

const getFees = (amount) => Math.floor((amount * config.feesPercent) / 100.0);

router.post('/create', postLimiter, async function (req, res) {
  logger.log('/create', [req.id]);
  if (!(req.body.partnerid && req.body.partnerid === 'bluewallet' && req.body.accounttype)) return errorBadArguments(res);

  let u = new User(redis, lightning);
  await u.create();
  await u.saveMetadata({
    partnerid: req.body.partnerid,
    accounttype: req.body.accounttype,
    created_at: new Date().toISOString()
  });
  res.send({ login: u.getLogin(), password: u.getPassword() });
});

router.post('/auth', postLimiter, async function (req, res) {
  logger.log('/auth', [req.id]);
  if (!((req.body.login && req.body.password) || req.body.refresh_token)) return errorBadArguments(res);

  let u = new User(redis, lightning);

  if (req.body.refresh_token) {
    // need to refresh token
    if (await u.loadByRefreshToken(req.body.refresh_token)) {
      res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    } else {
      return errorBadAuth(res);
    }
  } else {
    // need to authorize user
    let result = await u.loadByLoginAndPassword(req.body.login, req.body.password);
    if (result) res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    else errorBadAuth(res);
  }
});

router.post('/addinvoice', postLimiter, authenticator, async function (req, res) {
  logger.log('/addinvoice', [req.id]);
  let u = req.user;
  logger.log('/addinvoice', [req.id, 'userid: ' + u.getUserId()]);

  if (!req.body.amt || /*stupid NaN*/ !(req.body.amt > 0)) return errorBadArguments(res);

  const invoice = new Invo(redis, lightning);
  const r_preimage = invoice.makePreimageHex();
  lightning.addInvoice(
    {
      memo: req.body.memo,
      value: req.body.amt,
      expiry: 3600 * 24,
      r_preimage: Buffer.from(r_preimage, 'hex').toString('base64'),
    },
    async function (err, info) {
      if (err) return errorLnd(res);

      info.pay_req = info.payment_request; // client backwards compatibility
      await u.saveUserInvoice(info);
      await invoice.savePreimage(r_preimage);

      res.send(info);
    },
  );
});


router.post('/payinvoice', authenticator, async function (req, res) {
  let u = req.user;
  logger.log('/payinvoice', [req.id, 'userid: ' + u.getUserId(), 'invoice: ' + req.body.invoice]);
  if (!req.body.invoice) return errorBadArguments(res);
  let freeAmount = false;
  if (req.body.amount) {
    freeAmount = parseInt(req.body.amount);
    if (freeAmount <= 0) return errorBadArguments(res);
  }

  // obtaining a lock
  let lock = new Lock(redis, 'invoice_paying_for_' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return errorGeneralServerError(res);
  }

  let userBalance;
  try {
    userBalance = await u.getCalculatedBalance();
  } catch (Error) {
    logger.log('', [req.id, 'error running getCalculatedBalance():', Error.message]);
    lock.releaseLock();
    return errorTryAgainLater(res);
  }

  lightning.decodePayReq({ pay_req: req.body.invoice }, async function (err, info) {
    if (err) {
      await lock.releaseLock();
      return errorNotAValidInvoice(res);
    }

    if (+info.num_satoshis === 0) {
      // 'tip' invoices
      info.num_satoshis = freeAmount;
    }

    logger.log('/payinvoice', [req.id, 'userBalance: ' + userBalance, 'num_satoshis: ' + info.num_satoshis]);

    const totalDue = +info.num_satoshis + getFees(info.num_satoshis);
    if (userBalance >= totalDue) {
      // got enough balance, including 1% of payment amount - reserve for fees

      if (identity_pubkey === info.destination) {
        // this is internal invoice
        // now, receiver add balance
        let userid_payee = await u.getUseridByPaymentHash(info.payment_hash);
        if (!userid_payee) {
          await lock.releaseLock();
          return errorGeneralServerError(res);
        }

        if (await u.getPaymentHashPaid(info.payment_hash)) {
          // this internal invoice was paid, no sense paying it again
          await lock.releaseLock();
          return errorLnd(res);
        }

        let UserPayee = new User(redis, lightning);
        UserPayee._userid = userid_payee; // hacky, fixme
        await UserPayee.clearBalanceCache();

        // sender spent his balance:
        await u.clearBalanceCache();
        await u.savePaidLndInvoice({
          timestamp: parseInt(+new Date() / 1000),
          type: 'paid_invoice',
          value: +info.num_satoshis + Math.floor(info.num_satoshis * Paym.fee),
          fee: Math.floor(info.num_satoshis * Paym.fee),
          memo: decodeURIComponent(info.description),
          pay_req: req.body.invoice,
        });

        const invoice = new Invo(redis, lightning);
        invoice.setInvoice(req.body.invoice);
        await invoice.markAsPaidInDatabase();

        // now, faking LND callback about invoice paid:
        const preimage = await invoice.getPreimage();
        if (preimage) {
          subscribeInvoicesCallCallback({
            state: 'SETTLED',
            memo: info.description,
            r_preimage: Buffer.from(preimage, 'hex'),
            r_hash: Buffer.from(info.payment_hash, 'hex'),
            value: +info.num_satoshis,
          });
        }
        await lock.releaseLock();
        return res.send(info);
      }

      // else - regular lightning network payment:

      var call = lightning.sendPayment();
      call.on('data', async function (payment) {
        // payment callback
        await u.unlockFunds(req.body.invoice);
        if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
          let PaymentShallow = new Paym(false);
          payment = PaymentShallow.processSendPaymentResponse(payment);
          payment.pay_req = req.body.invoice;
          payment.decoded = info;
          await u.savePaidLndInvoice(payment);
          await u.clearBalanceCache();
          lock.releaseLock();
          res.send(payment);
        } else {
          // payment failed
          lock.releaseLock();
          console.log('Payment Failure:', payment ? JSON.stringify(payment) : '-');
          return errorPaymentFailed(res, payment && payment.payment_error);
        }
      });
      if (!info.num_satoshis) {
        // tip invoice, but someone forgot to specify amount
        await lock.releaseLock();
        return errorBadArguments(res);
      }
      let inv = {
        payment_request: req.body.invoice,
        amt: info.num_satoshis, // amt is used only for 'tip' invoices
        fee_limit: { fixed: Math.floor(info.num_satoshis * 0.005) + 1 },
      };
      try {
        await u.lockFunds(req.body.invoice, info);
        call.write(inv);
      } catch (err) {
        await lock.releaseLock();
        console.error('Payment could not be completed:', err);
        return errorPaymentFailed(res, err.message);
      }
    } else {
      await lock.releaseLock();
      return errorNotEnoughBalance(res);
    }
  });
});

router.get('/getbtc', authenticator, async function (req, res) {
  logger.log('/getbtc', [req.id]);
  let address = await req.user.getOrGenerateAddress();
  res.send([{ address }]);
});

router.get('/checkpayment/:payment_hash', authenticator, async function (req, res) {
  logger.log('/checkpayment', [req.id]);
  const u = req.user;
  let paid = true;
  if (!(await u.getPaymentHashPaid(req.params.payment_hash))) { // Not found on cache
    paid = await u.syncInvoicePaid(req.params.payment_hash);
  }
  res.send({ paid: paid });
});

const normaliseInvoiceResponse = (invoice, type) => {
  const output = { type };
  if (type === 'paid_invoice') {
    output.payment_hash = jsonBufferToHex(invoice.payment_hash);
    output.amt = parseInt(invoice.value) - invoice.fee;
    output.fees = invoice.fee;
    output.direction = 'outgoing';
    output.pay_req = invoice.pay_req;
    output.is_paid = true;
    output.expiry = invoice.expiry;
    output.timestamp = invoice.timestamp;
    output.description = invoice.memo;
  } else if (type === 'user_invoice') {
    output.payment_hash = invoice.payment_hash;
    output.amt = invoice.amt;
    output.fees = 0;
    output.direction = 'incoming';
    output.pay_req = invoice.payment_request;
    output.is_paid = invoice.ispaid;
    output.expiry = invoice.expire_time;
    output.timestamp = invoice.timestamp;
    output.description = invoice.description;
  } else if (type === 'locked_payment') {
    output.payment_hash = invoice.payment_hash;
    output.amt = parseInt(invoice.num_satoshis);
    output.fees = 0;
    output.direction = 'outgoing';
    output.pay_req = invoice.pay_req;
    output.is_paid = false;
    output.expiry = parseInt(invoice.expiry);
    output.timestamp = invoice.timestamp;
    output.description = invoice.description;
  }

  return output;
};

const decodeInvoice = async (pay_req) => {
  return new Promise((resolve, reject) => {
    lightning.decodePayReq({ pay_req }, function (err, info) {
      if (err) reject(err);
      resolve(info);
    });
  });
};

const jsonBufferToHex = (obj) => Buffer.from(obj.data).toString('hex');

// Find user's invoice from different sources
// First check last 500 paid invoices
// Next, check in generated invoice
// Then check in locked invoices - most resource intensive
router.get('/finduserinvoice/:payment_hash', authenticator, async function (req, res) {
  logger.log('/finduserinvoice', [req.id]);
  const { payment_hash } = req.params;
  const u = req.user;
  let invoice;

  //check paid invoices
  const paidInvoices = await u.getPaidInvoices(500);
  invoice = paidInvoices.find((d) => jsonBufferToHex(d.payment_hash) === payment_hash);
  if (invoice) {
    return res.send(normaliseInvoiceResponse(invoice, invoice.type));
  }

  const userInvoices = await u.getUserInvoices(500);
  invoice = userInvoices.find((inv) => inv.payment_hash === payment_hash);
  if (invoice) {
    return res.send(normaliseInvoiceResponse(invoice, invoice.type));
  }
  // check locked invoices
  const lockedInvoices = await u.getLockedPayments();
  for (let inv of lockedInvoices) {
    try {
      const decoded = await decodeInvoice(inv.pay_req);
      if (decoded.payment_hash === payment_hash) {
        decoded.pay_req = inv.pay_req;
        return res.send(normaliseInvoiceResponse(decoded, 'locked_payment'));
      }
    } catch (err) {
      console.error('FIND_INVOICE decode error :: ', inv.pay_req);
    }
  }

  errorInvoiceNotFound(res);
});


router.get('/balance', postLimiter, authenticator, async function (req, res) {
  let u = req.user;
  try {
    logger.log('/balance', [req.id, 'userid: ' + u.getUserId()]);
    await u.getOrGenerateAddress();
    let balance = await u.getBalance();
    if (balance < 0) balance = 0;
    res.send({ BTC: { AvailableBalance: balance } });
  } catch (Error) {
    logger.log('', [req.id, 'error getting balance:', Error.message, 'userid:', u.getUserId()]);
    return errorGeneralServerError(res);
  }
});

router.get('/getinfo', postLimiter, authenticator, async function (req, res) {
  logger.log('/getinfo', [req.id]);
  lightning.getInfo({}, function (err, info) {
    if (err) return errorLnd(res);
    res.send(info);
  });
});

router.get('/gettxs', authenticator, async function (req, res) {
  logger.log('/gettxs', [req.id]);
  let u = req.user;
  logger.log('/gettxs', [req.id, 'userid: ' + u.getUserId()]);

  await u.getOrGenerateAddress();
  try {
    let txs = await u.getTxs();
    let lockedPayments = await u.getLockedPayments();
    for (let locked of lockedPayments) {
      const fee = getFees(locked.amount);
      txs.push({
        type: 'paid_invoice',
        fee,
        value: locked.amount + fee /* feelimit */,
        timestamp: locked.timestamp,
        memo: 'Payment in transition',
      });
    }
    res.send(txs);
  } catch (Err) {
    logger.log('', [req.id, 'error gettxs:', Err.message, 'userid:', u.getUserId()]);
    res.send([]);
  }
});

router.get('/getuserinvoices', postLimiter, authenticator, async function (req, res) {
  logger.log('/getuserinvoices', [req.id]);
  let u = req.user;
  logger.log('/getuserinvoices', [req.id, 'userid: ' + u.getUserId()]);

  try {
    let invoices = await u.getUserInvoices(req.query.limit);
    res.send(invoices);
  } catch (Err) {
    logger.log('', [req.id, 'error getting user invoices:', Err.message, 'userid:', u.getUserId()]);
    res.send([]);
  }
});

router.get('/getpending', authenticator, async function (req, res) {
  logger.log('/getpending', [req.id]);
  const u = req.user;
  logger.log('/getpending', [req.id, 'userid: ' + u.getUserId()]);

  await u.getOrGenerateAddress();
  let txs = await u.getPendingTxs();
  res.send(txs);
});

router.get('/decodeinvoice', authenticator, async function (req, res) {
  logger.log('/decodeinvoice', [req.id]);
  let u = req.user;

  if (!req.query.invoice) return errorGeneralServerError(res);

  lightning.decodePayReq({ pay_req: req.query.invoice }, function (err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

router.get('/checkrouteinvoice', authenticator, async function (req, res) {
  logger.log('/checkrouteinvoice', [req.id]);
  let u = req.user;

  if (!req.query.invoice) return errorGeneralServerError(res);

  // at the momment does nothing.
  // TODO: decode and query actual route to destination
  lightning.decodePayReq({ pay_req: req.query.invoice }, function (err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

module.exports = router;

// ################# HELPERS ###########################

function errorBadAuth(res) {
  return res.status(401).send({
    error: true,
    code: 1,
    message: 'bad auth',
  });
}

function errorNotEnoughBalance(res) {
  return res.status(400).send({
    error: true,
    code: 2,
    message: `Not enough balance. Make sure you have at least ${config.feesPercent}% reserved for potential fees`,
  });
}

function errorNotAValidInvoice(res) {
  return res.status(400).send({
    error: true,
    code: 4,
    message: 'not a valid invoice',
  });
}

function errorLnd(res) {
  return res.status(500).send({
    error: true,
    code: 7,
    message: 'LND failure',
  });
}

function errorGeneralServerError(res) {
  return res.status(500).send({
    error: true,
    code: 6,
    message: 'Something went wrong. Please try again later',
  });
}

function errorBadArguments(res) {
  return res.status(400).send({
    error: true,
    code: 8,
    message: 'Bad arguments',
  });
}

function errorTryAgainLater(res) {
  return res.status(503).send({
    error: true,
    code: 9,
    message: 'Your previous payment is in transit. Try again in 5 minutes',
  });
}

function errorPaymentFailed(res, message = null) {
  return res.status(400).send({
    error: true,
    code: 10,
    message: message || 'Payment failed. Does the receiver have enough inbound capacity?',
  });
}

function errorInvoiceNotFound(res) {
  return res.status(404).send({
    error: true,
    code: 11,
    message: 'Could not find invoice with specified hash',
  });
}
