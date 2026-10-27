const Joi = require("joi");

exports.loginSchema = Joi.object({
  username: Joi.string().min(3).max(32).required(),
  password: Joi.string().min(6).max(64).required()
});

exports.tokenSchema = Joi.object({
  token: Joi.string().min(20).required()
});

exports.genericSchema = Joi.object({
  id: Joi.string().required()
});
