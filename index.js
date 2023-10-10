import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import xml_bodyparser from 'express-xml-bodyparser';
import xml2js from 'xml2js';
import JSONdb from 'simple-json-db';
import Api2d from 'api2d';
import fetch from 'cross-fetch';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import knex from 'knex';

// 从 .env 文件中读取环境变量
dotenv.config();
const { 
        MP_TOKEN,MP_APPID, MP_APPSECRET, 
        TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_API, 
        DB_TYPE, DB_HOST, DB_PORT, DB_USER, DB_PASSWD, DB_NAME, DB_TABLE, 
        DEFAULT_API_URL, DEFAULT_API_KEY, DEFAULT_API_WORD, DEFAULT_MODEL, 
        LOCK_API_URL, LOCK_API_KEY, LOCK_API_WORD, LOCK_MODEL,
        MAX_TOKEN, TEMPERATURE, TIMEOUT, STREAM, REPLY_CHUNK_LENGHT 
    } = process.env;

let db;
if (DB_TYPE === 'json') {
    db = new JSONdb('/data/db.json');
} else {

    const connection = knex({
        client: DB_TYPE,
        connection: {
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWD,
            database: DB_NAME
        },
    });

    db = {
        get: async (key) => {
            const ret = await connection(DB_TABLE).where({ key }).first()
            console.log("db get", key, ret?.value);
            return ret && ret.value || null;
        },
        set: async (key, value) => {
            // 查询key是否存在，存在则更新，不存在则插入
            const ret = await connection(DB_TABLE).where({ key }).first();
            console.log("db set", key, value, ret);
            if (ret) {
                await connection(DB_TABLE).where({ key }).update({ value });
            } else {
                await connection(DB_TABLE).insert({ key, value });
            }
        }
    }
}


// 缓存直接写系统目录
const cache = new JSONdb('/tmp/cache.json');

const cmdDocs = [`命令：\n`];
if (!LOCK_API_KEY) cmdDocs.push('🎈 /setKey=API_KEY - 设置OPENAI/API+/API2d Key');
if (!LOCK_API_URL) cmdDocs.push('🎈 /setUrl=API_URL - 设置OPENAI/API+/API2d API入口，不包含 /v1/chat/...部分');
if (!LOCK_API_WORD) cmdDocs.push('🎈 /setWord=API_WORD - 设置问答触发词');
cmdDocs.push('🎈 /setSystem=SYSTEM_MESSAGE - 设置系统提示词');
if (!LOCK_MODEL) cmdDocs.push('🎈 /setModel=MODEL_NAME - 设置模型名称');

const helpDoc = cmdDocs.join('\n');

const app = express();
app.use(cors());

app.all('/wechat', xml_bodyparser(), checkSignature, async (req, res) => {
    const xml = req.body.xml;
    const { msgtype, fromusername, tousername, content } = xml;
    if (!content || !tousername || !msgtype) {
        // 解析不到对应的结果，跳过
        res.send('success');
        return false;
    }
    let input = content[0];
    const openid = fromusername[0];
    switch (msgtype[0]) {
        case 'text':
            // 通过正则表达式匹配命令
            // :key=value
            const reg = /^\/(\w+)=(.*?)($|\s)/;
            const result = input.match(reg);
            if (result) {
                const key = result[1];
                const value = result[2];
                switch (String(key).toLowerCase()) {
                    case 'setkey':
                        if (LOCK_API_KEY) {
                            sendReply(res, makeMsg(fromusername[0], tousername[0], 'Command setkey locked'));
                        } else {
                            await db.set(`API_KEY_${openid}`, value);
                            sendReply(res, makeMsg(fromusername[0], tousername[0], "API_KEY saved"));
                        }
                        break;
                    case 'seturl':
                        if (LOCK_API_URL) {
                            sendReply(res, makeMsg(fromusername[0], tousername[0], 'Command seturl locked'));
                        } else {
                            await db.set(`API_URL_${openid}`, value);
                            sendReply(res, makeMsg(fromusername[0], tousername[0], "API_URL saved"));
                        }
                        break;
                    case 'setword':
                        if (LOCK_API_WORD) {
                            sendReply(res, makeMsg(fromusername[0], tousername[0], 'Command setword locked'));
                        } else {
                            await db.set(`API_WORD_${openid}`, value);
                            sendReply(res, makeMsg(fromusername[0], tousername[0], "API_WORD saved"));
                        }
                        break;
                    case 'setsystem':
                        await db.set(`API_SYSTEM_MESSAGE_${openid}`, value);
                        sendReply(res, makeMsg(fromusername[0], tousername[0], "API_SYSTEM_MESSAGE saved"));
                        break;
                    case 'setmodel':
                        if (LOCK_MODEL) {
                            sendReply(res, makeMsg(fromusername[0], tousername[0], 'Command setmodel locked'));
                        } else {
                            await db.set(`MODEL_${openid}`, value);
                            sendReply(res, makeMsg(fromusername[0], tousername[0], "MODEL saved"));
                        }
                        break;
                    default:
                        sendReply(res, makeMsg(fromusername[0], tousername[0], 'Unknown command'));
                        break;
                }
                return true;
            }
            else if (input === '/help') {
                sendReply(res, makeMsg(fromusername[0], tousername[0], helpDoc));
                return true;
            } else {
                // 如果没有定义的命令
                const word = await db.get(`API_WORD_${openid}`) || DEFAULT_API_WORD;
                const key = await db.get(`API_KEY_${openid}`) || DEFAULT_API_KEY;
                const url = await db.get(`API_URL_${openid}`) || DEFAULT_API_URL;
                if ( !key || !url) {
                    // 
                    sendReply(res, makeMsg(fromusername[0], tousername[0], `请先设置API_KEY[${key ? '✅' : '❌'}] - API_URL[${url ? '✅' : '❌'}] - API_WORD[${word ? word : ' '}]\n\n${helpDoc}`));
                    res.send('success');
                    return true;

                } else {
                    
                    // 如果设置了触发词
                    if( word )
                    {
                        if( input.indexOf(word) !== -1 )
                        {
                            input = input.replace(word, '');
                        }else
                        {
                            return res.send('success');
                        }
                    }
                        
                    res.send('success');
                    process.nextTick(() => {
                        // 调用API
                        llmReply(key, url, input, openid);
                    });

                    return true;
                    
                    
                }
            }
            break;
    }
    res.send('success');
    return true;
});

app.all('/telegram', bodyParser.json(), async (req, res) => {
    const { message } = req.body;
    const input = message.text;
    const reply = message.reply_to_message?.text||"";
    const fromid = message.from.id;
    console.log("telegram", req.body);
    const reg = /^\/(\w+)=(.*?)($|\s)/;
    const result = input.match(reg);
    console.log("input parse", result);
    if (result) {
        const key = result[1];
        const value = result[2];
        switch (String(key).toLowerCase()) {
            case 'setkey':
                if (LOCK_API_KEY) {
                    await tgReply(fromid, 'Command setkey locked');
                } else {
                    await db.set(`API_KEY_${fromid}`, value);
                    await tgReply(fromid, "API_KEY saved");
                }
                break;
            case 'seturl':
                if (LOCK_API_URL) {
                    await tgReply(fromid, 'Command seturl locked');
                } else {
                    await db.set(`API_URL_${fromid}`, value);
                    await tgReply(fromid, "API_URL saved");
                }
                break;
            case 'setword':
                if (LOCK_API_WORD) {
                    await tgReply(fromid, 'Command setword locked');
                } else {
                    await db.set(`API_WORD_${fromid}`, value);
                    await tgReply(fromid, "API_WORD saved");
                }
                break;
            case 'setsystem':
                await db.set(`API_SYSTEM_MESSAGE_${fromid}`, value);
                await tgReply(fromid, "API_SYSTEM_MESSAGE saved");
                break;
            default:
                await tgReply(fromid, 'Unknown command');
                break;
        }
        res.send('success');
        return true;
    }
    else if (input === '/help') {
        await tgReply(fromid, helpDoc);
        res.send('success');
        return true;
    }
    else {
        // 如果没有定义的命令
        const word = await db.get(`API_WORD_${fromid}`) || DEFAULT_API_WORD;
        const key = await db.get(`API_KEY_${fromid}`) || DEFAULT_API_KEY;
        const url = await db.get(`API_URL_${fromid}`) || DEFAULT_API_URL;
        if (!key || !url) {
            await tgReply(fromid, `请先设置API_KEY[${key ? '✅' : '❌'}] - API_URL[${url ? '✅' : '❌'}] - API_WORD[${word ? word : ' '}]\n\n${helpDoc}`);
            res.send('success');
            return true;
        } else {
            
            // 如果设置了触发词
            if( word )
            {
                if( input.indexOf(word) !== -1 )
                {
                    input = input.replace(word, '');
                }else
                {
                    return res.send('success');
                }
            }
                
            res.send('success');
            const msg = reply ? `引用：${reply}\n\n${input}` : input;
            process.nextTick(() => {
                llmReply(key, url, msg, fromid, 'telegram');
            });

            return true;
            
        }
    }
    res.send('success');
    return true;
});

app.use((err, req, res, next) => {
    console.error(err); // 将错误信息打印到控制台
    // 根据需要进行其他处理，例如发送错误响应给客户端
    res.status(500).send('Internal Server Error');
});

app.listen(9000, () => {
    console.log('Web server started on port 9000');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // 应用可能需要做一些清理工作
});

process.on('uncaughtException', (err, origin) => {
    console.error('Caught exception:', err, 'Exception origin:', origin);
    // 应用可能需要做一些清理工作
});

// ==== functions ===

async function tgReply(uid, content, format = 'text') {
    const url = `${TELEGRAM_BOT_API}bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    // MarkdownV2
    // content = format.toLowerCase() === 'markdownv2' ? tg_escape_v2(content) : content;

    const data = {
        chat_id: uid,
        text: content,
        // parse_mode: format
    };

    console.log("tg send", url, JSON.stringify(data));

    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json'
        }
    });

    const json = await response.text();
    console.log("tg ret", json);
    return json;

}

async function llmReply(apikey, url, content, openid, type = 'wechat') {
    if (type === 'wechat') sendTyping(openid);
    else sendTypingTg(openid);

    // let lastContent = '';
    const stream = String(STREAM).toLowerCase() === 'true';
    let buffer = '';
    const api2d = new Api2d(apikey, url, (TIMEOUT||180)*1000 );
    const messages = [{
        "role": "user",
        "content": content
    }];
    const systemMessage = await db.get(`API_SYSTEM_MESSAGE_${openid}`);
    if (systemMessage) {
        messages.unshift({
            "role": "system",
            "content": systemMessage
        });
    }
    const payload = {
        model: db.get(`MODEL_${openid}`) || DEFAULT_MODEL,
        messages,
        stream,
        onMessage: async (chars, char) => {
            // 流模式下，每返回 REPLY_CHUNK_LENGHT 个字符，就发送一次
            buffer = buffer + char;
            if (buffer.length > REPLY_CHUNK_LENGHT) {
                const retContent = buffer+'…';
                buffer = '';
                if (type == 'wechat')
                    await sendMessage(openid, retContent);
                else
                    await tgReply(openid, retContent);
            }
        }
    };
    if (MAX_TOKEN) payload.max_tokens = parseInt(MAX_TOKEN);
    if (TEMPERATURE) payload.temperature = parseFloat(TEMPERATURE);

    console.log("ai payload", payload);

    const result = await api2d.completion(payload)
    // 非流式下，直接发送
    if (!stream) {
        console.log("ai ret", result);
        const retContent = result.error ? JSON.parse(result.error).error.message : result.choices[0].message.content;
        // 如果 retContent 长度超过 REPLY_CHUNK_LENGHT ，则分段发送
        const chunks = splitString(retContent, parseInt(REPLY_CHUNK_LENGHT)||1000);
        console.log("chunks", chunks);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (type == 'wechat')
                await sendMessage(openid, chunk);
            else
                await tgReply(openid, chunk);
        }
    }else
    {
        // 如果 buffer 里还有内容，发送
        buffer += '◾️';
        if (buffer.length > 0) {
            if (type == 'wechat')
                await sendMessage(openid, buffer);
            else
                await tgReply(openid, buffer);
        }
        
    }

    return result;
}

// 发送客服输入状态
async function sendTyping(openid) {
    const atoken = await getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=${atoken}`;

    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
            touser: openid,
            command: 'Typing'
        })
    });
    const json = await response.json();
    // console.log(json);
    return json;
}

async function sendTypingTg(uid) {
    const url = `${TELEGRAM_BOT_API}bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
    const data = {
        chat_id: uid,
        action: 'typing'
    };
    // console.log("tg typing", url, JSON.stringify(data));
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json'
        }
    });

    const json = await response.text();
    // console.log("tg typing ret", json);
    return json;
}

// 发送客服消息
async function sendMessage(openid, content) {
    const atoken = await getAccessToken();
    if (!atoken) {
        console.log("get access token failed");
        return false;
    } else {
        // console.log("get access token ok", atoken);
    }
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${atoken}`;

    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
            touser: openid,
            msgtype: 'text',
            text: {
                content: content
            }
        })
    });
    const json = await response.json();
    // console.log(json);
    if (json.errcode === 40001) {
        cache.delete('access_token_info');
        return false;
    }
    return json;
}

async function getAccessToken() {
    const cacheInfo = cache.get('access_token_info');
    // 如果是五分钟前的数据，重新获取
    if (cacheInfo && cacheInfo.timestamp + 5 * 60 * 1000 > Date.now()) {
        return cacheInfo.access_token;
    } else {
        console.log("remove cache");
        cache.delete('access_token_info');
    }

    const url = `https://api.weixin.qq.com/cgi-bin/stable_token`;
    // 获取 stable token
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
            appid: MP_APPID,
            secret: MP_APPSECRET,
            grant_type: 'client_credential'
        })
    });
    const json = await response.json();
    // console.log("stable token ret", json);
    if (!json.errcode) {
        const save = {
            access_token: json.access_token,
            timestamp: Date.now(),
            expired_at: Date.now() + (json.expires_in - 30) * 1000
        };
        cache.set('access_token_info', save);
        return json.access_token;
    }
    return false;

}

function makeMsg(fromusername, tousername, content) {
    return {
        ToUserName: fromusername,
        FromUserName: tousername,
        CreateTime: Date.now(),
        MsgType: 'text',
        Content: content
    };
}

function sendReply(res, payload) {
    // 如果没有设置Content-Type，那么设置为text/xml
    if (!res.get('Content-Type')) {
        res.set('Content-Type', 'text/xml');
    }
    res.send(json2xml(payload));
}

function checkSignature(req, res, next) {
    const { signature, echostr, timestamp, nonce } = req.query;

    if (echostr) {
        res.send(echostr);
        return;
    }
    const token = MP_TOKEN;
    const arr = [token, timestamp, nonce];
    arr.sort();
    const str = arr.join('');
    const sha1 = crypto.createHash('sha1');
    sha1.update(str);
    const sha1Str = sha1.digest('hex');
    if (sha1Str !== signature) {
        res.send('Invalid signature');
        return;
    }

    next();
}

function json2xml(json) {
    return (new xml2js.Builder()).buildObject({ xml: json }).replace(/<\?xml.*?\?>\s*/, "");
}

function tg_escape_v2(string) {
    const specialCharacters = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    const escapedCharacters = ['\\_', '\\*', '\\[', '\\]', '\\(', '\\)', '\\~', '\\`', '\\>', '\\#', '\\+', '\\-', '\\=', '\\|', '\\{', '\\}', '\\.', '\\!'];

    return string.replace(specialCharacters, escapedCharacters);
};

function splitString(str, length) {
    let result = [];
    for (var i = 0; i < str.length; i += length) {
      result.push(str.substring(i, i + length));
    }
    return result;
  }


