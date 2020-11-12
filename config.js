let config = {
  redisUri: process.env.REDIS_URI || 'redis://127.0.0.1:6379',
  lnd: {
    url: process.env.LND_URL || '127.0.0.1:10009',
    password: process.env.LND_URL || '',
  },
};

if (process.env.CONFIG) {
  console.log('using config from env');
  config = JSON.parse(process.env.CONFIG);
}

module.exports = config;
