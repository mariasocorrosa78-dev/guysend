const cryptoUtils = require("./CryptoUtils.js");
const shared = require("./shared.json");
const dotenv = require("dotenv");
dotenv.config();

function generateAuthPayload() {
  const salt = process.env.LeagueSalt;
  if (!salt) {
    throw new Error("LeagueSalt not defined in .env");
  }

  return shared;
}

module.exports = {
  generateAuthPayload
};
