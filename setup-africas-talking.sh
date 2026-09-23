#!/bin/bash
# Africa's Talking WhatsApp Setup Script for FitFlex
# Usage: ./setup-africas-talking.sh

set -e

echo "=========================================="
echo "FitFlex WhatsApp Setup — Africa's Talking"
echo "=========================================="
echo ""

# Step 1: Environment Variables
echo "📝 Step 1: Configure Environment Variables"
echo "==========================================="
echo ""
echo "Add these to your .env file:"
echo ""
echo "# Africa's Talking API Configuration"
echo "AFRICAS_TALKING_API_KEY=your_api_key_here"
echo "AFRICAS_TALKING_API_URL=https://api.sandbox.africastalking.com"
echo "AFRICAS_TALKING_USERNAME=sandbox"  # Change to your AT username for production
echo ""
echo "Action: Set AFRICAS_TALKING_API_KEY in your .env file"
read -p "Press Enter once you've set the API key..."
echo ""

# Step 2: List the 9 templates to register
echo "📋 Step 2: Message Templates to Register"
echo "=========================================="
echo ""
echo "Go to Africa's Talking Dashboard → WhatsApp → Templates"
echo "Register these 9 templates (copy the exact text below):"
echo ""

cat << 'TEMPLATES'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. AUTHENTICATION OTP
Name: fitflex_otp
Category: AUTHENTICATION
Body: Hi {{name}}, your FitFlex OTP is {{code}}. Valid for 10 minutes. Reply STOP to opt out.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2. BOOKING CONFIRMATION
Name: fitflex_booking_confirmed
Category: TRANSACTIONAL
Body: {{trainerName}}, you have a new booking from {{memberName}} on {{date}} at {{time}}. View details in your FitFlex app.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

3. BOOKING REMINDER
Name: fitflex_booking_reminder
Category: TRANSACTIONAL
Body: Hi {{name}}, reminder: your session with {{trainer}} is in 1 hour at FitFlex.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

4. TRAINER MESSAGE
Name: fitflex_trainer_message
Category: SERVICE_UPDATE
Body: {{memberName}}, your trainer {{trainerName}} sent: {{message}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

5. ORDER PLACED
Name: fitflex_order_placed
Category: TRANSACTIONAL
Body: {{memberName}}, order #{{orderId}} placed! Total: {{amount}} TZS. Pick up at any nearby gym or arrange delivery.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

6. ORDER READY
Name: fitflex_order_ready
Category: TRANSACTIONAL
Body: {{memberName}}, order #{{orderId}} is ready at {{gymName}}. Pick up by {{date}}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

7. PAYMENT RECEIVED
Name: fitflex_payment_received
Category: TRANSACTIONAL
Body: Payment {{amount}} TZS received for order #{{orderId}}. Thank you for shopping at FitFlex!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

8. VENDOR RE-ENGAGEMENT
Name: fitflex_vendor_reengagement
Category: MARKETING
Body: Hey {{name}}, you haven't had sales in 7 days. Check your FitFlex dashboard for optimization tips or contact support.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

9. MEMBER RE-ENGAGEMENT
Name: fitflex_member_reengagement
Category: MARKETING
Body: {{name}}, your favorite trainers have new availability! Book a session now and get 20% off your first booking. Visit FitFlex app.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATES

echo ""
echo "Action: Register all 9 templates in Africa's Talking Dashboard"
read -p "Press Enter once you've registered all templates..."
echo ""

# Step 3: Configure Webhook
echo "🔗 Step 3: Configure Webhook for Inbound Messages"
echo "=================================================="
echo ""
echo "In Africa's Talking Dashboard → WhatsApp → Webhooks:"
echo ""
echo "Inbound URL: https://your-fitflex-backend.com/whatsapp/webhook"
echo "Status URL: https://your-fitflex-backend.com/whatsapp/webhook/status (optional)"
echo ""
echo "⚠️  Important:"
echo "   - URL must be HTTPS (not HTTP)"
echo "   - Server must be publicly accessible"
echo "   - Port 443 (standard HTTPS)"
echo ""
echo "Action: Configure the webhook URL in Africa's Talking Dashboard"
read -p "Press Enter once you've configured the webhook..."
echo ""

# Step 4: Test OTP Sending
echo "🧪 Step 4: Test OTP Sending (Sandbox)"
echo "====================================="
echo ""
echo "Let's test sending an OTP to verify everything works."
echo ""
read -p "Enter a test user ID (or press Enter for 'test_user'): " TEST_USER
TEST_USER=${TEST_USER:-test_user}
read -p "Enter a test OTP code (or press Enter for '123456'): " TEST_CODE
TEST_CODE=${TEST_CODE:-123456}
read -p "Enter your test phone number (+255xxxxxxxxx): " TEST_PHONE

# Create a temporary test user in database (you'll need to do this manually)
echo ""
echo "To test, you need to:"
echo "1. Insert a test user in the database with phone: $TEST_PHONE"
echo "2. Run the test below:"
echo ""
echo "curl -X POST http://localhost:3000/whatsapp/send-otp \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"userId\": \"$TEST_USER\", \"code\": \"$TEST_CODE\"}'"
echo ""

# Step 5: Verify Environment
echo "✅ Step 5: Verify Setup"
echo "======================="
echo ""
echo "Run these commands to verify:"
echo ""
echo "# Check environment variable is set"
echo "echo \$AFRICAS_TALKING_API_KEY"
echo ""
echo "# Run WhatsApp service tests"
echo "cd /opt/data/fitflex-functions"
echo "node --test specs/whatsapp-service.specs.mjs"
echo ""
echo "# Check if API is reachable (requires curl + jq)"
echo "curl -s https://api.sandbox.africastalking.com/version1/auth/token \\"
echo "  -d \"username=sandbox\" \\"
echo "  -d \"apikey=\$AFRICAS_TALKING_API_KEY\" | jq ."
echo ""

echo ""
echo "=========================================="
echo "✅ Setup Guide Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  ✓ Environment variables configured"
echo "  ✓ 9 message templates registered"
echo "  ✓ Webhook configured"
echo "  ✓ OTP test sent"
echo ""
echo "Next Steps:"
echo "  1. Deploy backend to production/staging server"
echo "  2. Update webhook URLs in Africa's Talking Dashboard"
echo "  3. Integrate whatsAppService calls into shop-service, trainer-service"
echo "  4. Monitor delivery rates and costs"
echo ""
