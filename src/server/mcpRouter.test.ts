import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKRALLY_VIDEO_MODELS, WORKRALLY_VIDEO_RATIOS } from '../config/workrallyVideoModels';
import { WORKRALLY_IMAGE_MODELS, WORKRALLY_IMAGE_RATIOS } from '../config/workrallyImageModels';

test('Rally-Video configuration conforms to WorkRally specifications', () => {
  const rallyVideo = WORKRALLY_VIDEO_MODELS.find(m => m.name === 'Rally-Video');
  assert.ok(rallyVideo, 'Rally-Video must exist in WORKRALLY_VIDEO_MODELS');
  assert.equal(rallyVideo.id, 'vuhkzt245c');
  assert.equal(rallyVideo.mode, 'SubjectToVideo');
  assert.equal(rallyVideo.supportAudio, false);
  assert.deepEqual(rallyVideo.resolutions, [{ label: '720p', value: 3 }]);
  assert.ok(rallyVideo.durations.includes(5) && rallyVideo.durations.includes(15));
  assert.equal(rallyVideo.durations.length, 11);
});

test('Video models list contains all 22 required models', () => {
  assert.equal(WORKRALLY_VIDEO_MODELS.length, 22);
  const expectedIds = [
    'vuhkzt245c', 'eiilbg0p3f', 'hur68xij1s', 'p4v9iqe4o4', 'gdwkwbr6zc',
    'cgmr507ycu', 'ym0d8bxf29', 'rvxcy3vti9', 'qa3zsyxzc8', '69h80rex3l',
    '73z6gomtng', '7cmqdq935y', '8axbdvnzpx', 'w40rawwolu', 'stzzmw4voz',
    '7tf7zt13aq', 'rag68r2kle', 'dowlc43l9l', 'jjcqfg14lb', '4g8ncz5ne8',
    '4yst38t78i', '4j1kej41ku'
  ];
  for (const id of expectedIds) {
    assert.ok(WORKRALLY_VIDEO_MODELS.some(m => m.id === id), `Missing video model with id: ${id}`);
  }
});

test('Image models list contains all 17 required models', () => {
  assert.equal(WORKRALLY_IMAGE_MODELS.length, 17);
  const expectedIds = [
    '8zueiutezp', 'tc8agh7y6n', 'g26a0h6skn', 'w6uxmppxi0', 'vzajz9vl65',
    'ttrqp3crkr', 'uoifr1f6z2', 'wtp483xcvd', 'wg2pbhna94', 'dhjz9kzjnw',
    'dxf3xs1t2l', 'a9lj0xftam', 'epejduyxsr', 'ehrw7lrj74', 'w02eww5li4',
    '6cu0lcwkz4', 'ygkgqsosdb'
  ];
  for (const id of expectedIds) {
    assert.ok(WORKRALLY_IMAGE_MODELS.some(m => m.id === id), `Missing image model with id: ${id}`);
  }
});
