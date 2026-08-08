const { get } = require('./store');
module.exports = () => get().count;
