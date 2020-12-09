// setup lnd rpc
const config = require('./config');
const { lnrpc, creds } = require('./lnrpc-loader');

module.exports = new lnrpc.Lightning(config.lnd.url, creds, { 'grpc.max_receive_message_length': 1024 * 1024 * 1024 });
