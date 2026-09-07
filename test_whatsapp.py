import json
import requests

with open("alerts_config.json", "r", encoding="utf-8") as f:
    cfg = json.load(f)

wa = cfg["whatsapp"]
recipient = wa["recipient"]
apikey = wa["apikey"]

print(f"Sending test WhatsApp message to: {recipient}...")

url = "https://api.textmebot.com/send.php"
params = {
    "recipient": recipient,
    "apikey": apikey,
    "text": "🔔 Test alert from your S/R & Price Alert Notifier Bot! If you see this, TextMeBot is working perfectly.",
}

try:
    response = requests.get(url, params=params, timeout=15)
    print(f"HTTP Status: {response.status_code}")
    print(f"Response Body: {response.text}")
except Exception as e:
    print(f"Error sending message: {e}")
