/**
 * This handles communication with the API server.
 */

import ws from "ws";
import logger from "../logger";
import crypto from 'crypto';
import { client as bot } from '../..';
import { EventEmitter } from "events";
import { parseUser } from "../util";
import PendingLogin from "../../struct/PendingLogin";
import { LogLevel } from "log75";
import { ulid } from "ulid";

const wsEvents = new EventEmitter();
const { API_WS_URL, API_WS_TOKEN } = process.env;
const wsQueue: { [key: string]: string }[] = [];
let client: ws|undefined = undefined;

if (!API_WS_URL || !API_WS_TOKEN)
    logger.info("$API_WS_URL or $API_WS_TOKEN not found.");
else {
    logger.info(`$API_WS_URL and $API_WS_TOKEN set; Connecting to ${API_WS_URL}`);
    connect();
}

function connect() {
    if (client && client.readyState == ws.OPEN) client.close();
    client = new ws(API_WS_URL!, { headers: { authorization: API_WS_TOKEN! } });

    client.once("open", () => {
        logger.debug("WS connected");
        if (wsQueue.length > 0) {
            logger.debug(`Attempting to send ${wsQueue.length} queued WS messages`);

            while (wsQueue.length > 0) {
                if (client?.readyState != ws.OPEN) break;
                const data = JSON.stringify(wsQueue.shift());
                logger.debug(`[WS] [FROM QUEUE] [>] ${data}`);
                client.send(data);
            }
        }
    });

    client.once("close", () => {
        client = undefined;
        logger.warn(`WS closed, reconnecting in 3 seconds`);
        setTimeout(connect, 3000);
    });

    client.once('error', (err) => {
        client = undefined;
        logger.warn(`WS: ${err}`);
    });

    client.on('message', (msg) => {
        logger.debug(`[WS] [<] ${msg.toString('utf8')}`);
        try {
            const jsonMsg = JSON.parse(msg.toString('utf8'));
            wsEvents.emit('message', jsonMsg);
            if (jsonMsg['nonce'] && jsonMsg['type']) {
                const hasListeners = wsEvents.emit(`req:${jsonMsg.type}`, jsonMsg.data, (res: { [key: string]: any }) => {
                    wsSend({ nonce: jsonMsg.nonce, type: `response:${jsonMsg.nonce}`, data: res });
                });

                if (!hasListeners) {
                    wsSend({
                        nonce: jsonMsg.nonce,
                        type: `response:${jsonMsg.nonce}`,
                        data: {
                            success: false,
                            error: 'No event listeners available for event'
                        }
                    });
                }
            }
        } catch(e) { console.error(e) }
    });
}

function wsSend(data: { [key: string]: any }) {
    if (client && client.readyState == client.OPEN) {
        logger.debug(`[WS] [>] ${JSON.stringify(data)}`);
        client.send(JSON.stringify(data));
    } else {
        logger.debug(`[WS] [QUEUED] [>] ${JSON.stringify(data)}`);
        wsQueue.push(data);
    }
}

wsEvents.on('req:test', (data: any, res: (data: any) => void) => {
    res({ received: data });
});

wsEvents.on('req:requestLogin', async (data: any, cb: (data: any) => void) => {
    try {
        const user = await parseUser(data.user);
        if (!user)
            return cb({ success: false, statusCode: 404, error: `The specified user could not be found` });
        
        let code: string|null = null;
        while (!code) {
            const c = crypto.randomBytes(8).toString('hex');
            const found = await bot.db.get('pending_logins').find({ code: c, user: user._id, confirmed: false });
            if (found.length > 0) continue;
            code = c.substring(0, 8).toUpperCase();
        }

        logger.info(`Attempted login for user ${user._id} with code ${code}`);

        const nonce = ulid();

        const previousLogins = await bot.db.get('pending_logins').find({ user: user._id, confirmed: true });

        await bot.db.get('pending_logins').insert({
            code,
            expires: Date.now() + (1000 * 60 * 15), // Expires in 15 minutes
            user: user._id,
            nonce: nonce,
            confirmed: false,
            requirePhishingConfirmation: previousLogins.length == 0,
            exchanged: false,
            invalid: false,
        } as PendingLogin);

        cb({ success: true, uid: user._id, nonce, code });
    } catch(e) {
        console.error(e);
        cb({ success: false, error: e });
    }
});

export { wsEvents, wsSend }
