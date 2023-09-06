import makeWASocket, { AnyMessageContent, delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore, useMultiFileAuthState } from "@whiskeysockets/baileys"
import P from "pino"
import NodeCache from 'node-cache'


const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')


const msgRetryCounterCache = new NodeCache()


// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
    store?.writeToFile('./baileys_store_multi.json')
}, 10_000)


async function createSocket(session_folder: string) {
    const { state, saveCreds } = await useMultiFileAuthState('sessions/' + session_folder)
    // fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)
    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            /** caching makes the store faster to send/recv messages */
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true
    })
    return { sock, saveCreds }
}


async function HandleSocket(session_id: string) {
    const socket = await createSocket(session_id)
    store?.bind(socket.sock.ev)
    socket.sock.ev.process(
        // events is a map for event name => event data
        async (events) => {
            // something about the connection changed
            // maybe it closed, or we received all offline message or connection opened
            if (events['connection.update']) {
                const update = events['connection.update']
                const { connection, lastDisconnect } = update
                if (connection === 'close') {
                    // reconnect if not logged out
                    console.log(lastDisconnect?.error?.message)
                    console.log(lastDisconnect?.error?.name)
                    console.log(lastDisconnect?.error?.stack)
                    if (lastDisconnect?.error) {
                        HandleSocket(session_id)
                    } else {
                        console.log('Connection closed. You are logged out.')
                    }
                }

                console.log('connection update', update)
            }

            // credentials updated -- save them
            if (events['creds.update']) {
                await socket.saveCreds()
            }

            if (events['labels.association']) {
                console.log(events['labels.association'])
            }


            if (events['labels.edit']) {
                console.log(events['labels.edit'])
            }

            if (events.call) {
                console.log('recv call event', events.call)
            }

            // history received
            if (events['messaging-history.set']) {
                const { chats, contacts, messages, isLatest } = events['messaging-history.set']
                console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
            }

            // received a new message
            if (events['messages.upsert']) {
                const upsert = events['messages.upsert']
                console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

                if (upsert.type === 'notify') {
                    for (const msg of upsert.messages) {
                        let id = msg.key.remoteJid!
                        if (!msg.key.fromMe && doReplies) {
                            console.log('replying to', msg.key.remoteJid)
                            await socket.sock!.readMessages([msg.key])
                            await sendMessageWTyping({ text: `Hello there! i am from session id ${session_id}` }, msg.key.remoteJid!)
                            // // send a link
                            // await sock.sendMessage(id, { text: 'Hi, this was sent using https://github.com/adiwajshing/baileys' })
                            // await socket.sock.sendMessage(id, {
                            //     video: { url: "https://www.w3schools.com/tags/movie.mp4" },
                            //     fileName: "agarson catalouge",
                            //     caption: "download Catalouge",
                            // })
                            // await sock.sendMessage(
                            //     id,
                            //     { location: { degreesLatitude: 24.121231, degreesLongitude: 55.1121221 } }
                            // )
                            // const vcard = 'BEGIN:VCARD\n' // metadata of the contact card
                            //     + 'VERSION:3.0\n'
                            //     + 'FN:Jeff Singh\n' // full name
                            //     + 'ORG:Ashoka Uni;\n' // the organization of the contact
                            //     + 'TEL;type=CELL;type=VOICE;waid=911234567890:+91 12345 67890\n' // WhatsApp ID + phone number
                            //     + 'END:VCARD'
                            // const sentMsg = await sock.sendMessage(
                            //     id,
                            //     {
                            //         contacts: {
                            //             displayName: 'Jeff',
                            //             contacts: [{ vcard }]
                            //         }
                            //     }
                            // )




                            // const reactionMessage = {
                            //     react: {
                            //         text: "💖", // use an empty string to remove the reaction
                            //         key: msg.key
                            //     }
                            // }

                            // const sendMsg = await sock.sendMessage(id, reactionMessage)
                        }
                    }
                }
            }

            // messages updated like status delivered, message deleted etc.
            if (events['messages.update']) {
                console.log(
                    JSON.stringify(events['messages.update'], undefined, 2)
                )

                if (events['message-receipt.update']) {
                    console.log(events['message-receipt.update'])
                }

                if (events['messages.reaction']) {
                    console.log(events['messages.reaction'])
                }

                if (events['presence.update']) {
                    console.log(events['presence.update'])
                }

                if (events['chats.update']) {
                    console.log(events['chats.update'])
                }

                if (events['contacts.update']) {
                    for (const contact of events['contacts.update']) {
                        if (typeof contact.imgUrl !== 'undefined') {
                            const newUrl = contact.imgUrl === null
                                ? null
                                : await socket.sock!.profilePictureUrl(contact.id!).catch(() => null)
                            console.log(
                                `contact ${contact.id} has a new profile pic: ${newUrl}`,
                            )
                        }
                    }
                }

                if (events['chats.delete']) {
                    console.log('chats deleted ', events['chats.delete'])
                }
            }
        }
    )
    const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
        await socket.sock.presenceSubscribe(jid)
        await delay(500)

        await socket.sock.sendPresenceUpdate('composing', jid)
        await delay(2000)

        await socket.sock.sendPresenceUpdate('paused', jid)

        await socket.sock.sendMessage(jid, msg)
    }
}


HandleSocket("nishu1")
HandleSocket("nishu2")