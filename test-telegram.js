const axios = require('axios');

const BOT_TOKEN = '7805057774:AAEoyNQYUNXFnBmhLEO3HfJjwP_AZe4Rd5w';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function testBot() {
  try {
    // Get bot info
    console.log('Testing bot connection...');
    const botInfo = await axios.get(`${API_URL}/getMe`);
    console.log('Bot info:', botInfo.data.result);
    
    // Get webhook info
    console.log('\nGetting webhook info...');
    const webhookInfo = await axios.get(`${API_URL}/getWebhookInfo`);
    console.log('Webhook info:', webhookInfo.data.result);
    
    // Get updates (if no webhook is set)
    if (!webhookInfo.data.result.url) {
      console.log('\nGetting updates...');
      const updates = await axios.get(`${API_URL}/getUpdates`);
      console.log('Recent updates:', updates.data.result.slice(-3));
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testBot();