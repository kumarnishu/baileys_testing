import makeWASocket, { AnyMessageContent, DisconnectReason, WAMessageContent, WAMessageKey, delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore, useMultiFileAuthState } from "@whiskeysockets/baileys"
import P from "pino"
import NodeCache from 'node-cache'


const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

const msgRetryCounterCache = new NodeCache()

// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
    store?.writeToFile('./baileys_store_multi.json')
}, 10_000)


const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
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
    store?.bind(sock.ev)


    const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
        await sock.presenceSubscribe(jid)
        await delay(500)

        await sock.sendPresenceUpdate('composing', jid)
        await delay(2000)

        await sock.sendPresenceUpdate('paused', jid)

        await sock.sendMessage(jid, msg)
    }
    sock.ev.process(
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
                        startSock()
                    } else {
                        console.log('Connection closed. You are logged out.')
                    }
                }

                console.log('connection update', update)
            }

            // credentials updated -- save them
            if (events['creds.update']) {
                await saveCreds()
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
                            await sock!.readMessages([msg.key])
                            await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
                            // send a link
                            await sock.sendMessage(id, { text: 'Hi, this was sent using https://github.com/adiwajshing/baileys' })
                            await sock.sendMessage(id, {
                                document: { url: "https://ik.imagekit.io/ghzlr9kj8/Agarson_Folder.pdf?updatedAt=1688643310063" },
                                fileName: "agarson catalouge",
                                caption: "download Catalouge",
                                mimetype: 'application/pdf'
                            })
                            await sock.sendMessage(
                                id,
                                { location: { degreesLatitude: 24.121231, degreesLongitude: 55.1121221 } }
                            )
                            const vcard = 'BEGIN:VCARD\n' // metadata of the contact card
                                + 'VERSION:3.0\n'
                                + 'FN:Jeff Singh\n' // full name
                                + 'ORG:Ashoka Uni;\n' // the organization of the contact
                                + 'TEL;type=CELL;type=VOICE;waid=911234567890:+91 12345 67890\n' // WhatsApp ID + phone number
                                + 'END:VCARD'
                            const sentMsg = await sock.sendMessage(
                                id,
                                {
                                    contacts: {
                                        displayName: 'Jeff',
                                        contacts: [{ vcard }]
                                    }
                                }
                            )
                            const sections = [
                                {
                                    title: "Section 1",
                                    rows: [
                                        { title: "Option 1", rowId: "option1" },
                                        { title: "Option 2", rowId: "option2", description: "This is a description" }
                                    ]
                                },
                                {
                                    title: "Section 2",
                                    rows: [
                                        { title: "Option 3", rowId: "option3" },
                                        { title: "Option 4", rowId: "option4", description: "This is a description V2" }
                                    ]
                                },
                            ]

                            const listMessage = {
                                text: "This is a list",
                                footer: "nice footer, link: https://google.com",
                                title: "Amazing boldfaced list title",
                                buttonText: "Required, text on the button to view the list",
                                sections
                            }

                            await sock.sendMessage(id, listMessage)
                            const reactionMessage = {
                                react: {
                                    text: "💖", // use an empty string to remove the reaction
                                    key: msg.key
                                }
                            }

                            const sendMsg = await sock.sendMessage(id, reactionMessage)
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
                                : await sock!.profilePictureUrl(contact.id!).catch(() => null)
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
    return sock
}
startSock()