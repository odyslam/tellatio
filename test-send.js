const axios = require('axios');

const BOT_TOKEN = '7805057774:AAEoyNQYUNXFnBmhLEO3HfJjwP_AZe4Rd5w';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTestMessage() {
  try {
    // First, check for any chat IDs from previous messages
    console.log('Checking for updates to find a chat ID...');
    const updates = await axios.get(`${API_URL}/getUpdates`);
    
    if (updates.data.result.length > 0) {
      const lastUpdate = updates.data.result[updates.data.result.length - 1];
      if (lastUpdate.message && lastUpdate.message.chat) {
        const chatId = lastUpdate.message.chat.id;
        console.log(`Found chat ID: ${chatId}`);
        
        // Send a test message
        const message = 'Hello! This is a test message from the Attio-Telegram integration.';
        const response = await axios.post(`${API_URL}/sendMessage`, {
          chat_id: chatId,
          text: message
        });
        
        console.log('Message sent successfully:', response.data.result);
      } else {
        console.log('No valid chat found in updates');
      }
    } else {
      console.log('No updates found. Please send a message to @tellatio_bot first!');
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

sendTestMessage();