const express = require('express');
const { getChatbotReply } = require('../controllers/chatbotController');

const router = express.Router();

router.get('/reply', getChatbotReply);

module.exports = router;
