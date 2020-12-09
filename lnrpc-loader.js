// setup lnd rpc
const fs = require('fs');
const grpc = require('grpc');
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';
var lndCert;
if (process.env.TLSCERT) {
  lndCert = Buffer.from(process.env.TLSCERT, 'hex');
} else {
  lndCert = fs.readFileSync('tls.cert');
}
process.env.VERBOSE && console.log('using tls.cert', lndCert.toString('hex'));
let sslCreds = grpc.credentials.createSsl(lndCert);
let macaroon;
if (process.env.MACAROON) {
  macaroon = process.env.MACAROON;
} else {
  macaroon = fs.readFileSync('admin.macaroon').toString('hex');
}
process.env.VERBOSE && console.log('using macaroon', macaroon);
const macaroonCreds = grpc.credentials.createFromMetadataGenerator(function (args, callback) {
  let metadata = new grpc.Metadata();
  metadata.add('macaroon', macaroon);
  callback(null, metadata);
});

module.exports = {
  lnrpc: grpc.load('rpc.proto').lnrpc,
  creds: grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds),
};

