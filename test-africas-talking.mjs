#!/bin/bash
# Test Africa's Talking WhatsApp Connection
# Run: node test-africas-talking.mjs

import('node:dotenv/config.js');
import fetch from 'node-fetch';

const API_KEY = process.env.AFRICAS_TALKING_API_KEY;
const API_URL = process.env.AFRICAS_TALKING_API_URL || 'https://api.sandbox.africastalking.com';

if (!API_KEY) {
  console.error('❌ AFRICAS_TALKING_API_KEY not set in environment');
  process.exit(1);
}

console.log('🧪 Testing Africa\'s Talking Connection\n');
console.log(`API URL: ${API_URL}`);
console.log(`API Key: ${API_KEY.slice(0, 10)}...`);
console.log('');

async function testConnection() {
  try {
    console.log('🔄 Test 1: Authenticate with Africa\'s Talking...');
    
    const response = await fetch(`${API_URL}/version1/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        username: 'sandbox',
        apikey: API_KEY,
      }).toString(),
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error('❌ Authentication Failed');
      console.error('Status:', response.status);
      console.error('Response:', result);
      process.exit(1);
    }

    if (result.isError) {
      console.error('❌ Africa\'s Talking Error:', result.error);
      process.exit(1);
    }

    console.log('✅ Authentication successful');
    console.log(`Token: ${result.data?.token?.slice(0, 20)}...`);
    console.log('');

    // Test 2: Check account balance (requires authenticated endpoint)
    console.log('🔄 Test 2: Fetch Account Info...');
    
    const accountResponse = await fetch(`${API_URL}/version1/user`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'apiKey': API_KEY,
      },
    });

    const accountResult = await accountResponse.json();
    
    if (!accountResponse.ok) {
      console.warn('⚠️  Account info not available (may require specific permissions)');
    } else {
      console.log('✅ Account Info:');
      if (accountResult.data) {
        console.log(`   Phone: ${accountResult.data.phone}`);
        console.log(`   Balance: ${accountResult.data.balance}`);
      }
    }

    console.log('');
    console.log('========================================');
    console.log('✅ Africa\'s Talking Connection OK!');
    console.log('========================================');
    console.log('');
    console.log('Next Steps:');
    console.log('  1. Register 9 message templates in AT Dashboard → WhatsApp → Templates');
    console.log('  2. Configure webhook: Dashboard → WhatsApp → Webhooks');
    console.log('  3. Run: node --test specs/whatsapp-service.specs.mjs');
    console.log('  4. Test OTP: curl -X POST http://localhost:3000/whatsapp/send-otp \\');
    console.log('                 -d \'{"userId": "test_user", "code": "123456"}\'');
    console.log('');

  } catch (err) {
    console.error('❌ Connection Error:', err.message);
    process.exit(1);
  }
}

testConnection();
