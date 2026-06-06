'use strict';

/**
 * metaApiService.js — Wrapper for Meta WhatsApp Cloud API
 *
 * All outbound API calls go through this service. This centralizes:
 *  - Authentication headers
 *  - URL construction
 *  - Error parsing (Meta has specific error codes we must handle)
 *  - Rate limit detection (HTTP 429 → trigger backoff in queue)
 *
 * Meta API Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Key rate limits (as of API v19.0):
 *  - 80 messages/second per phone number
 *  - 1,000 unique recipients per 24h on new numbers (scales with quality rating)
 */

const axios = require('axios');
const logger = require('../config/logger');

const BASE_URL = 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v19.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

/** Pre-configured axios instance for all Meta API calls */
const metaAxios = axios.create({
  baseURL: `${BASE_URL}/${API_VERSION}`,
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000, // 10-second timeout per request
});

// ─── Response interceptor: parse Meta error envelopes ────────────────────────
metaAxios.interceptors.response.use(
  (response) => response,
  (error) => {
    // Meta wraps errors in error.response.data.error
    if (error.response?.data?.error) {
      const metaError = error.response.data.error;
      const enhanced = new Error(metaError.message || 'Meta API error');
      enhanced.metaCode = metaError.code;
      enhanced.metaSubcode = metaError.error_subcode;
      enhanced.metaType = metaError.type;
      enhanced.httpStatus = error.response.status;
      throw enhanced;
    }
    throw error;
  }
);

// ─── Core send function ───────────────────────────────────────────────────────

/**
 * sendTemplateMessage — sends a single HSM template message to one recipient.
 *
 * @param {object} params
 * @param {string} params.to          - Recipient phone in E.164 format (e.g. "972501234567")
 * @param {string} params.templateName - Meta-approved template name
 * @param {string} params.languageCode - Template language (e.g. "he", "en_US")
 * @param {Array}  params.components   - Template variable components array
 * @returns {Promise<{wamid: string}>} The Meta message ID (wa_id)
 */
async function sendTemplateMessage({ to, templateName, languageCode = 'he', components = [] }) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components }),
    },
  };

  try {
    const response = await metaAxios.post(`/${PHONE_NUMBER_ID}/messages`, payload);
    const wamid = response.data?.messages?.[0]?.id;

    logger.debug('[MetaAPI] Message sent', { to, templateName, wamid });
    return { wamid, success: true };

  } catch (err) {
    logger.error('[MetaAPI] sendTemplateMessage failed', {
      to,
      templateName,
      metaCode: err.metaCode,
      httpStatus: err.httpStatus,
      message: err.message,
    });

    // Re-throw with enriched context so BullMQ worker can decide retry strategy
    const enriched = new Error(err.message);
    enriched.metaCode = err.metaCode;
    enriched.httpStatus = err.httpStatus;
    enriched.isRateLimit = err.httpStatus === 429;
    enriched.isPermanentFailure = [131_000, 131_005, 131_009].includes(err.metaCode);
    throw enriched;
  }
}

// ─── Utility functions ────────────────────────────────────────────────────────

/**
 * getPhoneNumberQuality — checks WABA phone number quality rating.
 * If rating drops to RED, broadcasts should pause automatically.
 *
 * @returns {Promise<{qualityRating: string, status: string}>}
 */
async function getPhoneNumberQuality() {
  try {
    const response = await metaAxios.get(`/${PHONE_NUMBER_ID}`, {
      params: { fields: 'quality_rating,status,display_phone_number' },
    });
    return response.data;
  } catch (err) {
    logger.error('[MetaAPI] Failed to fetch phone quality', { message: err.message });
    throw err;
  }
}

/**
 * getApprovedTemplates — fetches all approved templates for this WABA.
 * Used to sync templates into the WordPress database.
 *
 * @returns {Promise<Array>} Array of template objects
 */
async function getApprovedTemplates() {
  const wabaId = process.env.META_WABA_ID;
  try {
    const response = await metaAxios.get(`/${wabaId}/message_templates`, {
      params: {
        fields: 'name,status,category,language,components',
        status: 'APPROVED',
        limit: 100,
      },
    });
    return response.data?.data || [];
  } catch (err) {
    logger.error('[MetaAPI] Failed to fetch templates', { message: err.message });
    throw err;
  }
}

/**
 * markMessageAsRead — sends a read receipt to Meta for an inbound message.
 * Good practice for conversational flows.
 *
 * @param {string} wamid - The message ID from Meta webhook payload
 */
async function markMessageAsRead(wamid) {
  try {
    await metaAxios.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: wamid,
    });
  } catch (err) {
    // Non-critical — log and continue
    logger.warn('[MetaAPI] markMessageAsRead failed', { wamid, message: err.message });
  }
}

module.exports = {
  sendTemplateMessage,
  getPhoneNumberQuality,
  getApprovedTemplates,
  markMessageAsRead,
};
