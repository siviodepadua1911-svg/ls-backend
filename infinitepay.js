// infinitepay.js — Integração com InfinitePay (PIX grátis)
// Handle: LSautotruckrastreios | Taxa PIX: 0%
const axios = require('axios');

const HANDLE = process.env.INFINITEPAY_HANDLE || 'LSautotruckrastreios';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BASE_URL = 'https://api.infinitepay.io';

// ==========================================
// Gerar link de pagamento PIX
// ==========================================
async function generatePixLink({ chargeId, description, valueReais, dueDate, clientName, clientEmail, clientPhone }) {
  const valueCentavos = Math.round(valueReais * 100);
  const webhookUrl = `${BACKEND_URL}/api/webhook/infinitepay`;

  const payload = {
    handle: HANDLE,
    items: [
      {
        quantity: 1,
        price: valueCentavos,
        description: description.substring(0, 100)
      }
    ],
    capture_method: 'pix', // ← Força PIX (taxa 0%)
    order_nsu: `LS-${chargeId}-${Date.now()}`,
    webhook_url: webhookUrl,
    redirect_url: `${BACKEND_URL}/pagamento/obrigado`,
  };

  // Adicionar dados do cliente se disponíveis (agiliza o checkout)
  if (clientName || clientEmail || clientPhone) {
    payload.customer = {};
    if (clientName) payload.customer.name = clientName;
    if (clientEmail) payload.customer.email = clientEmail;
    if (clientPhone) payload.customer.phone_number = `+55${clientPhone.replace(/\D/g, '')}`;
  }

  try {
    const response = await axios.post(`${BASE_URL}/invoices/public/checkout/links`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    return {
      success: true,
      url: response.data.url,
      invoice_slug: response.data.invoice_slug || response.data.slug || null,
      qr_code: response.data.qr_code || null,
    };
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message || 'Erro desconhecido';
    console.error('❌ InfinitePay erro:', errMsg, error.response?.data);
    return {
      success: false,
      error: errMsg,
      // Fallback: link direto (sem webhook, mas funcional)
      url: `https://pay.infinitepay.io/${HANDLE}/${valueCentavos}/`,
    };
  }
}

// ==========================================
// Consultar status de um pagamento
// ==========================================
async function checkPaymentStatus(invoiceSlug) {
  try {
    const response = await axios.get(`${BASE_URL}/invoices/${invoiceSlug}`, {
      timeout: 8000
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==========================================
// Montar mensagem WhatsApp
// ==========================================
function buildWhatsAppMessage(charge, client, pixLink) {
  const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(charge.value);
  const venc = new Date(charge.due_date + 'T12:00:00').toLocaleDateString('pt-BR');

  return encodeURIComponent(
    `Olá ${client.name}! 🚛\n\n` +
    `*LS Auto Truck — Cobrança ${charge.num}*\n\n` +
    `📋 ${charge.description}\n` +
    `💰 Valor: *${valor}*\n` +
    `📅 Vencimento: *${venc}*\n\n` +
    `👉 *Pague via PIX (sem taxas):*\n` +
    `${pixLink}\n\n` +
    `_Dúvidas? (16) 3333-0000_\n` +
    `_LS Auto Truck — Rastreios e Manutenção_`
  );
}

// ==========================================
// Montar link WhatsApp
// ==========================================
function buildWhatsAppLink(phone, charge, client, pixLink) {
  const cleanPhone = phone.replace(/\D/g, '');
  const phoneWithCountry = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
  const message = buildWhatsAppMessage(charge, client, pixLink);
  return `https://wa.me/${phoneWithCountry}?text=${message}`;
}

module.exports = { generatePixLink, checkPaymentStatus, buildWhatsAppLink, buildWhatsAppMessage, HANDLE };
