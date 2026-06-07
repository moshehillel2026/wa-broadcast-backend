'use strict';

/**
 * server.js — Express Application Entry Point
 * Initializes and starts the WhatsApp Broadcasting API server.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./config/logger');
const { webhookRouter, rawBodyMiddleware } = require('./routes/webhookRoutes');
const campaignRoutes = require('./routes/campaignRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Security and Logging Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// Routes
app.use('/webhook', rawBodyMiddleware, webhookRouter);
app.use('/campaigns', campaignRoutes);

// Health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});