import test from 'node:test';
import assert from 'node:assert/strict';
import { hitBlow, validNumber, normalizeAnswer, graphemes, makeOptions, sanitiseConfig, TRACKS, filteredTracks } from '../server/engine.mjs';

test('Hit Blow sample and invalid digits',()=>{
  assert.deepEqual(hitBlow('123','132'), {hits:1,blows:2});
  assert.deepEqual(hitBlow('012','345'), {hits:0,blows:0});
  assert.deepEqual(hitBlow('012','012'), {hits:3,blows:0});
  assert.equal(validNumber('012',true),true);
  assert.equal(validNumber('012',false),false);
  assert.equal(validNumber('101',true),false);
  assert.equal(validNumber('1234',true),false);
});
test('answer normalization, kana and choices',()=>{
  assert.equal(normalizeAnswer('ＬＥＭＯＮ'),normalizeAnswer('Lemon'));
  assert.equal(normalizeAnswer('チェ リー！'),normalizeAnswer('チェリー'));
  assert.deepEqual(graphemes('チェリー'),['チ','ェ','リ','ー']);
  for (const ch of graphemes('チェリー')) {
    const choices=makeOptions(ch,TRACKS.map(t=>t.title));
    assert.equal(choices.length,4); assert.equal(new Set(choices).size,4); assert.equal(choices.filter(v=>v===ch).length,1);
  }
});
test('configuration validation and era filters',()=>{
  assert.equal(sanitiseConfig('quiz',{target:200}).target,5);
  assert.equal(sanitiseConfig('quiz',{answerSeconds:30}).answerSeconds,30);
  assert.equal(sanitiseConfig('hit',{turnSeconds:0}).turnSeconds,0);
  assert.ok(filteredTracks({difficulty:'easy',era:'昭和'}).every(x=>x.difficulty==='easy'&&x.era==='昭和'));
  assert.ok(TRACKS.every(x=>x.source==='original-demo'));
});
