// Required NPM Packages: 
// npm install

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

// Load variables from a local .env file (if it exists) into process.env
require('dotenv').config();

// Configuration from environment variables (see .env.example)
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`ERROR: Missing required environment variable ${name}.`);
        console.error('Copy .env.example to .env and set a value, or export the variable in your shell.');
        process.exit(1);
    }
    return value;
}

const SLACK_SIGNING_SECRET = requireEnv('SLACK_SIGNING_SECRET');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');
const ZAPIER_LINKEDIN_WEBHOOK = requireEnv('ZAPIER_LINKEDIN_WEBHOOK');
const ZAPIER_BLOG_WEBHOOK = requireEnv('ZAPIER_BLOG_WEBHOOK');
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = express();

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: ANTHROPIC_API_KEY
});

// Middleware - Parse URL-encoded bodies (Slack sends data as form-urlencoded)
app.use(bodyParser.urlencoded({ extended: true, verify: rawBodyBuffer }));

// Store raw body for signature verification
function rawBodyBuffer(req, res, buf, encoding) {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}

// Request logging middleware
app.use((req, res, next) => {
    console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
    console.log('Content-Type:', req.headers['content-type']);
    next();
});

/**
 * Verifies the Slack request signature to ensure request authenticity
 * @param {Object} req - Express request object
 * @returns {boolean} - True if signature is valid, false otherwise
 */
function verifySlackRequest(req) {
    try {
        const slackSignature = req.headers['x-slack-signature'];
        const timestamp = req.headers['x-slack-request-timestamp'];
        
        console.log('Verification - Slack Signature:', slackSignature);
        console.log('Verification - Timestamp:', timestamp);
        
        // Check if headers exist
        if (!slackSignature || !timestamp) {
            console.error('Verification FAILED: Missing signature or timestamp headers');
            return false;
        }
        
        // Prevent replay attacks - reject requests older than 5 minutes
        const currentTime = Math.floor(Date.now() / 1000);
        const timeDiff = Math.abs(currentTime - timestamp);
        console.log('Verification - Time difference (seconds):', timeDiff);
        
        if (timeDiff > 300) {
            console.error('Verification FAILED: Request too old (replay attack prevention)');
            console.error(`Current time: ${currentTime}, Request time: ${timestamp}, Diff: ${timeDiff}s`);
            return false;
        }
        
        // Check if rawBody exists
        if (!req.rawBody) {
            console.error('Verification FAILED: No raw body available for signature verification');
            return false;
        }
        
        // Create signature base string
        const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
        console.log('Verification - Base string:', sigBasestring);
        
        // Generate HMAC signature
        const mySignature = 'v0=' + crypto
            .createHmac('sha256', SLACK_SIGNING_SECRET)
            .update(sigBasestring, 'utf8')
            .digest('hex');
        
        console.log('Verification - My signature:', mySignature);
        console.log('Verification - Slack signature:', slackSignature);
        
        // Compare signatures using timing-safe comparison
        const isMatch = crypto.timingSafeEqual(
            Buffer.from(mySignature, 'utf8'),
            Buffer.from(slackSignature, 'utf8')
        );
        
        console.log('Verification - Signatures match:', isMatch);
        return isMatch;
    } catch (error) {
        console.error('Verification ERROR:', error.message);
        console.error('Verification ERROR Stack:', error.stack);
        return false;
    }
}

/**
 * Routes the command using Claude LLM to determine user intent
 * @param {string} commandText - The text from the Slack command
 * @returns {Promise<Object>} - Parsed intent with flow_name, primary_content, and details
 */
async function routeCommand(commandText) {
    try {
        console.log('========== CLAUDE ROUTING STARTED ==========');
        console.log('Command Text:', commandText);
        
        const systemPrompt = `You are Marvis, an intelligent command router for a Slack bot.
Your job is to analyze user commands and determine their intent.

You must classify commands into one of these three flows:
1. "blog" - User wants to create, schedule, or manage a blog post
2. "linkedin" - User wants to create, schedule, or manage a LinkedIn post
3. "text_response" - General conversation, questions, or commands that don't fit the above

Extract:
- primary_content: The main subject (URL, topic, or question)
- details: Any modifiers like timing ("tomorrow at 9am"), platform, or additional instructions

Examples:
- "blog about AI trends" → blog, "AI trends", ""
- "schedule a LinkedIn post for tomorrow at 9am about product launch" → linkedin, "product launch", "tomorrow at 9am"
- "what's the weather?" → text_response, "weather", ""
- "help me with something" → text_response, "help request", ""`;

        const userPrompt = `Analyze this command and classify it: "${commandText}"

You must respond using the route_command tool with the classification.`;

        const message = await anthropic.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
                { role: 'user', content: userPrompt }
            ],
            tools: [
                {
                    name: 'route_command',
                    description: 'Routes the user command to the appropriate flow based on intent analysis',
                    input_schema: {
                        type: 'object',
                        properties: {
                            flow_name: {
                                type: 'string',
                                enum: ['blog', 'linkedin', 'text_response'],
                                description: 'The flow to route to: blog, linkedin, or text_response'
                            },
                            primary_content: {
                                type: 'string',
                                description: 'The main subject, URL, or topic extracted from the command'
                            },
                            details: {
                                type: 'string',
                                description: 'Any modifiers like timing or additional instructions'
                            }
                        },
                        required: ['flow_name', 'primary_content', 'details']
                    }
                }
            ],
            tool_choice: { type: 'tool', name: 'route_command' }
        });

        console.log('Claude Response:', JSON.stringify(message, null, 2));
        
        // Extract the tool use from Claude's response
        const toolUse = message.content.find(block => block.type === 'tool_use');
        
        if (!toolUse || !toolUse.input) {
            throw new Error('Claude did not return tool use response');
        }
        
        const routingData = toolUse.input;
        
        console.log('Routing Data:', JSON.stringify(routingData, null, 2));
        console.log('Tokens Used - Input:', message.usage.input_tokens, 'Output:', message.usage.output_tokens);
        console.log('Flow Name:', routingData.flow_name);
        console.log('Primary Content:', routingData.primary_content);
        console.log('Details:', routingData.details);
        console.log('============================================');
        
        return routingData;
    } catch (error) {
        console.error('========== CLAUDE ROUTING ERROR ==========');
        console.error('Error Type:', error.name);
        console.error('Error Message:', error.message);
        console.error('Error Stack:', error.stack);
        
        if (error.response) {
            console.error('Anthropic Response Status:', error.response.status);
            console.error('Anthropic Response Data:', JSON.stringify(error.response.data, null, 2));
        }
        console.error('==========================================');
        
        // Fallback to text_response if Claude fails
        return {
            flow_name: 'text_response',
            primary_content: commandText,
            details: 'Claude routing failed, using fallback'
        };
    }
}

/**
 * Main endpoint for Slack Slash Command with LLM-based routing
 */
app.post('/slack-handler', async (req, res) => {
    try {
        console.log('========== NEW SLACK REQUEST ==========');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Request Body:', JSON.stringify(req.body, null, 2));
        console.log('Raw Body length:', req.rawBody ? req.rawBody.length : 'NO RAW BODY');
        
        // STEP 1: Verify Slack Request Signature
        console.log('Starting signature verification...');
        const isValid = verifySlackRequest(req);
        console.log('Signature verification result:', isValid);
        
        if (!isValid) {
            console.error('❌ SIGNATURE VERIFICATION FAILED');
            console.error('X-Slack-Signature:', req.headers['x-slack-signature']);
            console.error('X-Slack-Request-Timestamp:', req.headers['x-slack-request-timestamp']);
            return res.status(403).send('Request verification failed');
        }
        
        console.log('✅ Signature verified successfully');
        
        // STEP 2: Immediately respond to Slack (before 3-second timeout)
        console.log('Sending immediate response to Slack...');
        res.status(200).send({
            response_type: 'ephemeral',
            text: '🧠 Marvis is thinking about your request...'
        });
        console.log('✅ Response sent to Slack');
        
        // Extract data from Slack request
        const commandText = req.body.text || '';
        const userId = req.body.user_id || '';
        const userName = req.body.user_name || '';
        const responseUrl = req.body.response_url || '';
        const teamDomain = req.body.team_domain || '';
        
        console.log(`Extracted data - Command: "${commandText}", User: ${userName} (${userId})`);
        console.log(`Response URL: ${responseUrl}`);
        
        // STEP 3: Process asynchronously with LLM routing
        setImmediate(async () => {
            try {
                // Get routing decision from LLM
                const routingData = await routeCommand(commandText);
                
                console.log('========== ROUTING DECISION ==========');
                console.log('Flow:', routingData.flow_name);
                console.log('Primary Content:', routingData.primary_content);
                console.log('Details:', routingData.details);
                console.log('======================================');
                
                // Route based on LLM decision
                switch (routingData.flow_name) {
                    case 'blog':
                        console.log('========== BLOG FLOW TRIGGERED ==========');
                        console.log('Webhook URL:', ZAPIER_BLOG_WEBHOOK);
                        
                        const blogPayload = {
                            blog_title: routingData.primary_content,
                            details: routingData.details,
                            user_id: userId,
                            user_name: userName,
                            team_domain: teamDomain
                        };
                        
                        console.log('Blog Payload:', JSON.stringify(blogPayload, null, 2));
                        
                        const blogResponse = await axios.post(ZAPIER_BLOG_WEBHOOK, blogPayload, {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 10000
                        });
                        
                        console.log('✅ Blog webhook triggered successfully');
                        console.log('Zapier Response Status:', blogResponse.status);
                        console.log('Zapier Response Data:', JSON.stringify(blogResponse.data, null, 2));
                        console.log('=========================================');
                        break;
                        
                    case 'linkedin':
                        console.log('========== LINKEDIN FLOW TRIGGERED ==========');
                        console.log('Webhook URL:', ZAPIER_LINKEDIN_WEBHOOK);
                        
                        const linkedinPayload = {
                            post_content: routingData.primary_content,
                            details: routingData.details,
                            user_id: userId,
                            user_name: userName,
                            team_domain: teamDomain
                        };
                        
                        console.log('LinkedIn Payload:', JSON.stringify(linkedinPayload, null, 2));
                        
                        const linkedinResponse = await axios.post(ZAPIER_LINKEDIN_WEBHOOK, linkedinPayload, {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 10000
                        });
                        
                        console.log('✅ LinkedIn webhook triggered successfully');
                        console.log('Zapier Response Status:', linkedinResponse.status);
                        console.log('Zapier Response Data:', JSON.stringify(linkedinResponse.data, null, 2));
                        console.log('============================================');
                        break;
                        
                    case 'text_response':
                        console.log('========== TEXT RESPONSE FLOW TRIGGERED ==========');
                        console.log('Responding directly to Slack via response_url');
                        
                        if (!responseUrl) {
                            console.error('❌ No response_url available from Slack');
                            break;
                        }
                        
                        const slackMessage = {
                            text: `*Marvis Router:* I've identified this as a general query. Content: "${routingData.primary_content}". \n\nI should now generate the actual answer for you...`,
                            response_type: 'in_channel'
                        };
                        
                        console.log('Slack Message:', JSON.stringify(slackMessage, null, 2));
                        
                        const slackResponse = await axios.post(responseUrl, slackMessage, {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 10000
                        });
                        
                        console.log('✅ Slack response posted successfully');
                        console.log('Slack Response Status:', slackResponse.status);
                        console.log('=================================================');
                        break;
                        
                    default:
                        console.error('❌ Unknown flow_name:', routingData.flow_name);
                        break;
                }
                
            } catch (error) {
                console.error('========== ASYNC PROCESSING ERROR ==========');
                console.error('Error Type:', error.name);
                console.error('Error Message:', error.message);
                console.error('Error Stack:', error.stack);
                
                if (error.response) {
                    console.error('Response Status:', error.response.status);
                    console.error('Response Headers:', JSON.stringify(error.response.headers, null, 2));
                    console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
                } else if (error.request) {
                    console.error('No response received');
                    console.error('Request details:', error.request);
                } else {
                    console.error('Error setting up request:', error.message);
                }
                console.error('============================================');
            }
        });
        
    } catch (error) {
        console.error('========== CRITICAL ERROR IN MAIN HANDLER ==========');
        console.error('Error Type:', error.name);
        console.error('Error Message:', error.message);
        console.error('Error Stack:', error.stack);
        console.error('====================================================');
        
        // Try to respond if headers haven't been sent
        if (!res.headersSent) {
            res.status(500).send('Internal server error');
        }
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('Server is running');
});

// Global error handler for uncaught errors
app.use((err, req, res, next) => {
    console.error('========== GLOBAL ERROR HANDLER ==========');
    console.error('Error:', err);
    console.error('Stack:', err.stack);
    console.error('==========================================');
    
    if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
    }
});

// Handle 404s
app.use((req, res) => {
    console.log(`404 - Route not found: ${req.method} ${req.path}`);
    res.status(404).send('Not Found');
});

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('========== UNCAUGHT EXCEPTION ==========');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    console.error('========================================');
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('========== UNHANDLED PROMISE REJECTION ==========');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    console.error('=================================================');
});

// Start the server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🚀 MARVIS SLACK BRAIN SERVER (CLAUDE AGENT MODE)');
    console.log('='.repeat(50));
    console.log(`Port: ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/slack-handler`);
    console.log(`Health Check: http://localhost:${PORT}/health`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Node Version: ${process.version}`);
    console.log(`Slack Signing Secret: ${SLACK_SIGNING_SECRET ? '✅ SET' : '❌ NOT SET'}`);
    console.log(`Anthropic API Key: ${ANTHROPIC_API_KEY ? '✅ SET' : '❌ NOT SET'}`);
    console.log(`Anthropic Model: ${ANTHROPIC_MODEL}`);
    console.log(`Zapier Blog Webhook: ${ZAPIER_BLOG_WEBHOOK ? '✅ SET' : '❌ NOT SET'}`);
    console.log(`Zapier LinkedIn Webhook: ${ZAPIER_LINKEDIN_WEBHOOK ? '✅ SET' : '❌ NOT SET'}`);
    console.log('='.repeat(50));
    console.log('Waiting for Slack requests...\n');
});
