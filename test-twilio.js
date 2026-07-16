require('dotenv').config();
const twilio = require('twilio');

// Initialize with your credentials from .env
const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Replace this with your personal phone number (including country code, e.g., +919876543210)
const myPhoneNumber = '+918496043724';

console.log('Sending test SMS to:', myPhoneNumber);

client.messages.create({
  body: '🚜 This is a test message from your AgriPrice Portal Twilio integration!',
  from: process.env.TWILIO_PHONE_NUMBER,
  to: myPhoneNumber
})
  .then(message => console.log('✅ SMS Sent Successfully! Message SID:', message.sid))
  .catch(error => console.error('❌ Failed to send SMS:', error.message));
