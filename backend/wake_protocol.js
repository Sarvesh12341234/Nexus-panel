'use strict';

const crypto = require('node:crypto');

const raknetMagic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const wakeBedrockGuid = crypto.randomBytes(8);

function decodeMinecraftVarInt(buffer, offset = 0) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset + index >= buffer.length) return null;
    const byte = buffer[offset + index];
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return { value: value >>> 0, bytes: index + 1 };
  }
  return null;
}

function encodeMinecraftVarInt(value) {
  let remaining = Number(value) >>> 0;
  const bytes = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function frameMinecraftPacket(packet) {
  return Buffer.concat([encodeMinecraftVarInt(packet.length), packet]);
}

function minecraftString(value) {
  const content = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeMinecraftVarInt(content.length), content]);
}

function parseWakeHandshake(packet) {
  const packetId = decodeMinecraftVarInt(packet);
  if (!packetId || packetId.value !== 0) return null;
  let cursor = packetId.bytes;
  const protocol = decodeMinecraftVarInt(packet, cursor);
  if (!protocol) return null;
  cursor += protocol.bytes;
  const addressLength = decodeMinecraftVarInt(packet, cursor);
  if (!addressLength || addressLength.value > 255) return null;
  cursor += addressLength.bytes;
  if (cursor + addressLength.value + 2 > packet.length) return null;
  cursor += addressLength.value + 2; // Address and server port.
  const nextState = decodeMinecraftVarInt(packet, cursor);
  if (!nextState || ![1, 2].includes(nextState.value)) return null;
  return { protocol: protocol.value, nextState: nextState.value };
}

function isJavaLoginStart(packet) {
  const packetId = decodeMinecraftVarInt(packet);
  if (!packetId || packetId.value !== 0) return false;
  const nameLength = decodeMinecraftVarInt(packet, packetId.bytes);
  if (!nameLength || nameLength.value < 1 || nameLength.value > 16) return false;
  const start = packetId.bytes + nameLength.bytes;
  const end = start + nameLength.value;
  if (end > packet.length) return false;
  const usernameBytes = packet.subarray(start, end);
  const username = usernameBytes.toString('utf8');
  return username.length > 0
    && Buffer.from(username, 'utf8').equals(usernameBytes)
    && !/[\u0000-\u001f\u007f]/.test(username);
}

function shouldWakeJavaClient(handshake, packet) {
  return handshake?.nextState === 2 && isJavaLoginStart(packet);
}

function wakeJavaStatusPacket(protocol) {
  const response = {
    version: { name: 'Starting server...', protocol },
    players: { max: 20, online: 0, sample: [] },
    description: { text: 'Starting server... Please reconnect in a moment.' },
  };
  return frameMinecraftPacket(Buffer.concat([
    encodeMinecraftVarInt(0),
    minecraftString(JSON.stringify(response)),
  ]));
}

function wakeJavaDisconnectPacket() {
  return frameMinecraftPacket(Buffer.concat([
    encodeMinecraftVarInt(0),
    minecraftString(JSON.stringify({ text: 'Starting server... Please reconnect in a moment.' })),
  ]));
}

function wakeBedrockPong(packet, server) {
  // RakNet unconnected pings are sent by server lists and status monitors. They
  // receive a pong but must never start a sleeping game server.
  if (packet.length < 33 || ![0x01, 0x02].includes(packet[0]) || !packet.subarray(9, 25).equals(raknetMagic)) return null;
  const guid = wakeBedrockGuid.readBigUInt64BE().toString();
  const maxPlayers = Math.max(1, Number(server.max_players) || 20);
  const message = [
    'MCPE', 'Starting server...', '0', 'Starting', '0', String(maxPlayers), guid,
    'Please reconnect in a moment', 'Survival', '1', String(server.port), String(server.port), '',
  ].join(';');
  const encodedMessage = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(encodedMessage.length);
  return Buffer.concat([
    Buffer.from([0x1c]), packet.subarray(1, 9), wakeBedrockGuid, raknetMagic, length, encodedMessage,
  ]);
}

function isBedrockConnectionRequest(packet) {
  // RakNet open-connection requests 1/2 begin an actual Bedrock session. They
  // include the fixed magic directly after the packet ID, unlike status pings.
  return packet.length >= 18
    && [0x05, 0x07].includes(packet[0])
    && packet.subarray(1, 17).equals(raknetMagic);
}

module.exports = {
  decodeMinecraftVarInt,
  encodeMinecraftVarInt,
  frameMinecraftPacket,
  isBedrockConnectionRequest,
  isJavaLoginStart,
  parseWakeHandshake,
  shouldWakeJavaClient,
  wakeBedrockPong,
  wakeJavaDisconnectPacket,
  wakeJavaStatusPacket,
};
