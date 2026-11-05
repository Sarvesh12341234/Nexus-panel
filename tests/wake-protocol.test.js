'use strict';

const assert = require('node:assert/strict');
const {
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
} = require('../backend/wake_protocol');

const raknetMagic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const minecraftString = (value) => {
  const text = Buffer.from(value);
  return Buffer.concat([encodeMinecraftVarInt(text.length), text]);
};

function handshake(nextState) {
  const address = Buffer.from('play.example.test');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return Buffer.concat([
    encodeMinecraftVarInt(0),
    encodeMinecraftVarInt(765),
    encodeMinecraftVarInt(address.length),
    address,
    port,
    encodeMinecraftVarInt(nextState),
  ]);
}

assert.deepEqual(parseWakeHandshake(handshake(1)), { protocol: 765, nextState: 1 });
assert.deepEqual(parseWakeHandshake(handshake(2)), { protocol: 765, nextState: 2 });
assert.equal(parseWakeHandshake(Buffer.from([0, 1, 8, 97])), null);

const loginStart = Buffer.concat([encodeMinecraftVarInt(0), minecraftString('SkyFallen_1'), Buffer.alloc(17)]);
assert.equal(isJavaLoginStart(loginStart), true);
assert.equal(isJavaLoginStart(Buffer.concat([encodeMinecraftVarInt(0), minecraftString('Bedrock Player')])), true);
assert.equal(isJavaLoginStart(Buffer.concat([encodeMinecraftVarInt(1), minecraftString('SkyFallen_1')])), false);
assert.equal(isJavaLoginStart(Buffer.concat([encodeMinecraftVarInt(0), minecraftString('bad\0name')])), false);
assert.equal(isJavaLoginStart(Buffer.concat([encodeMinecraftVarInt(0), encodeMinecraftVarInt(16), Buffer.from('short')])), false);
assert.equal(shouldWakeJavaClient(parseWakeHandshake(handshake(1)), loginStart), false);
assert.equal(shouldWakeJavaClient(parseWakeHandshake(handshake(2)), loginStart), true);

const ping = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), raknetMagic, Buffer.alloc(8)]);
assert.ok(wakeBedrockPong(ping, { max_players: 20, port: 19132 }));
assert.equal(isBedrockConnectionRequest(ping), false);
const openConnection = Buffer.concat([Buffer.from([0x05]), raknetMagic, Buffer.from([11]), Buffer.alloc(40)]);
assert.equal(isBedrockConnectionRequest(openConnection), true);
assert.equal(isBedrockConnectionRequest(Buffer.concat([Buffer.from([0x05]), Buffer.alloc(40)])), false);

assert.ok(decodeMinecraftVarInt(frameMinecraftPacket(Buffer.from([0]))));
assert.ok(wakeJavaStatusPacket(765).length > 0);
assert.ok(wakeJavaDisconnectPacket().length > 0);

console.log('Wake-on-join protocol tests passed.');
