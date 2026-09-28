import { WorkRallyResolutionOption, WorkRallyQualityOption } from './workrallyImageModels';

export interface WorkRallyVideoModel {
  id: string;
  name: string;
  description?: string;
  mode?: string;
  durations: number[];
  supportAudio?: boolean;
  ratios?: string[];
  resolutions: WorkRallyResolutionOption[];
  qualities?: WorkRallyQualityOption[];
  toolName?: string;
}

export const WORKRALLY_VIDEO_TOOL = 'canvas_generate_video';

export const WORKRALLY_VIDEO_RATIOS: string[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

export const WORKRALLY_VIDEO_MODELS: WorkRallyVideoModel[] = [
  {
    id: 'vuhkzt245c',
    name: 'Rally-Video',
    description: 'WorkRally 官方旗舰级视频生成模型',
    mode: 'SubjectToVideo',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: 'eiilbg0p3f',
    name: 'Zen-01',
    description: 'Zen-01 影视级质感视频生成',
    mode: 'Text',
    durations: [5, 8, 10, 12],
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'hur68xij1s',
    name: 'Seedance-2.5',
    description: 'Seedance 2.5 高保真动作连贯生视频',
    mode: 'Text',
    durations: range(4, 30),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'p4v9iqe4o4',
    name: 'Wan3.0-Prime',
    description: 'Wan 3.0 Prime 旗舰视频大模型',
    mode: 'Text',
    durations: range(2, 30),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'gdwkwbr6zc',
    name: 'Wan-3.0',
    description: 'Wan 3.0 高动态生成模型',
    mode: 'Text',
    durations: range(2, 30),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'cgmr507ycu',
    name: 'MiniMax-H3',
    description: 'MiniMax H3 高性能生成',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
      { label: '2K', value: 5 },
    ],
  },
  {
    id: 'ym0d8bxf29',
    name: 'MiniMax-H3-Max',
    description: 'MiniMax H3 Max 极强叙事与运动张力',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: 'rvxcy3vti9',
    name: 'Seedance-2.0 FAST',
    description: 'Seedance 2.0 极速生成版',
    mode: 'Text',
    durations: range(4, 15),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: 'qa3zsyxzc8',
    name: 'Seedance-2.0',
    description: 'Seedance 2.0 旗舰视频生成',
    mode: 'Text',
    durations: range(4, 15),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
      { label: '1080p', value: 4 },
      { label: '4K', value: 6 },
    ],
  },
  {
    id: '69h80rex3l',
    name: 'Happyhorse-1.0',
    description: 'Happyhorse 1.0 创意视频大模型',
    mode: 'Text',
    durations: range(3, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: '73z6gomtng',
    name: 'Seedance-2.0 Mini',
    description: 'Seedance 2.0 Mini 轻量高效版',
    mode: 'Text',
    durations: range(4, 15),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
    ],
  },
  {
    id: '7cmqdq935y',
    name: 'Kling-O3',
    description: '快手可灵 Kling O3 电影级运镜',
    mode: 'Text',
    durations: range(3, 15),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '1080p', value: 4 },
      { label: '4K', value: 6 },
    ],
  },
  {
    id: '8axbdvnzpx',
    name: 'Vidu-Q3 Pro',
    description: 'Vidu Q3 Pro 顶级镜头感与动态',
    mode: 'Text',
    durations: [2, 3, 5, 8, 10, 13, 15],
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'w40rawwolu',
    name: 'Vidu-Q2 Pro',
    description: 'Vidu Q2 Pro 稳定连贯视频生成',
    mode: 'Text',
    durations: range(2, 10),
    supportAudio: true,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'stzzmw4voz',
    name: 'Zen-06',
    description: 'Zen-06 超高清艺术生视频',
    mode: 'Text',
    durations: [8],
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: '7tf7zt13aq',
    name: 'MiniMax-Hailuo-2.3',
    description: '海螺 MiniMax 2.3 超强动作连贯性',
    mode: 'Text',
    durations: [6, 10],
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: 'rag68r2kle',
    name: 'Happyhorse-1.1',
    description: 'Happyhorse 1.1 强化运动视频生成',
    mode: 'Text',
    durations: range(3, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
      { label: '1080p', value: 4 },
    ],
  },
  {
    id: 'dowlc43l9l',
    name: '谷宝-Omni',
    description: '谷宝-Omni 多模态全景视频生成',
    mode: 'Text',
    durations: range(3, 10),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [],
  },
  {
    id: 'jjcqfg14lb',
    name: 'MiniMax-H3-OS',
    description: 'MiniMax H3 OS 版',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
      { label: '2K', value: 5 },
    ],
  },
  {
    id: '4g8ncz5ne8',
    name: 'MiniMax-H3-Max-OS',
    description: 'MiniMax H3 Max OS 版',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '480p', value: 1 },
      { label: '720p', value: 3 },
    ],
  },
  {
    id: '4yst38t78i',
    name: 'MiniMax-H3-Max-Turbo',
    description: 'MiniMax H3 Max Turbo 极速版',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
  {
    id: '4j1kej41ku',
    name: 'MiniMax-H3-Max-Turbo-OS',
    description: 'MiniMax H3 Max Turbo OS 版',
    mode: 'Text',
    durations: range(5, 15),
    supportAudio: false,
    ratios: WORKRALLY_VIDEO_RATIOS,
    resolutions: [
      { label: '720p', value: 3 },
    ],
  },
];
