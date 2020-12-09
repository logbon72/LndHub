const { lnrpc, creds } = require('./lnrpc-loader');
const config = require('./config');

module.exports.unlock = async () => {
  if (!config.lnd.password) {
    return;
  }

  process.env.VERBOSE && console.log('trying to unlock the wallet');
  return new Promise((resolve, reject) => {
    const walletUnlocker = new lnrpc.WalletUnlocker(config.lnd.url, creds);
    walletUnlocker.unlockWallet(
      {
        wallet_password: Buffer.from(config.lnd.password).toString('base64'),
      },
      function (err, response) {
        if (err) {
          reject(err);
        } else {
          console.log('unlockWallet:', response);
          // Delay response for 2 seconds.
          setTimeout(() => resolve(response), 2000);
        }
      },
    );
  });
};
