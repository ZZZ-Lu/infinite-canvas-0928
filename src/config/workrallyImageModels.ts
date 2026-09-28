export interface WorkRallyResolutionOption {
  label: string;
  value: number | string;
}

export interface WorkRallyQualityOption {
  label: string;
  value: string | number;
}

export interface WorkRallyImageModel {
  id: string;
  name: string;
  description?: string;
  ratios?: string[];
  resolutions: WorkRallyResolutionOption[];
  qualities?: WorkRallyQualityOption[];
  toolName?: string;
}

export const WORKRALLY_IMAGE_TOOL = 'canvas_generate_image';

export const WORKRALLY_IMAGE_RATIOS_STANDARD: string[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const WORKRALLY_IMAGE_RATIOS_EXTENDED: string[] = ['21:9', '16:9', '4:3', '2:1', '1:1', '1:2', '3:4', '9:16'];
export const WORKRALLY_IMAGE_RATIOS: string[] = WORKRALLY_IMAGE_RATIOS_STANDARD;

const RES_1K = { label: '1K', value: 4 };
const RES_1080P = { label: '1080p', value: 4 };
const RES_2K = { label: '2K', value: 5 };
const RES_4K = { label: '4K', value: 6 };

const QUALITY_FULL: WorkRallyQualityOption[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'X-High', value: 'xhigh' },
  { label: 'Max', value: 'max' },
];

const QUALITY_3: WorkRallyQualityOption[] = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

export const WORKRALLY_IMAGE_MODELS: WorkRallyImageModel[] = [
  {
    id: '8zueiutezp',
    name: 'Hy Image3.5 preview',
    description: '腾讯混元图像生成 3.5 预览版',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K],
  },
  {
    id: 'tc8agh7y6n',
    name: '季宝2.5-极速版',
    description: '季宝 2.5 极速高效生图',
    ratios: WORKRALLY_IMAGE_RATIOS_EXTENDED,
    resolutions: [RES_1K, RES_2K, RES_4K],
    qualities: QUALITY_FULL,
  },
  {
    id: 'g26a0h6skn',
    name: '季宝2.5',
    description: '季宝 2.5 高品质生图模型',
    ratios: WORKRALLY_IMAGE_RATIOS_EXTENDED,
    resolutions: [RES_1K, RES_2K, RES_4K],
    qualities: QUALITY_FULL,
  },
  {
    id: 'w6uxmppxi0',
    name: '贝宝-Pro',
    description: '贝宝 Pro 专业旗舰生图',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K, RES_4K],
  },
  {
    id: 'vzajz9vl65',
    name: 'Seedream-5 Pro',
    description: 'Seedream 5 Pro 超精细画质',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K],
  },
  {
    id: 'ttrqp3crkr',
    name: '贝宝-1',
    description: '贝宝-1 基础图像生成',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K],
  },
  {
    id: 'uoifr1f6z2',
    name: '贝宝-2',
    description: '贝宝-2 进阶图像生成',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K, RES_4K],
  },
  {
    id: 'wtp483xcvd',
    name: 'ViduQ2',
    description: '生动高质量创意生图',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [],
  },
  {
    id: 'wg2pbhna94',
    name: 'Seedream-5 Lite',
    description: 'Seedream 5 Lite 轻量高效版',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_2K, RES_4K],
  },
  {
    id: 'dhjz9kzjnw',
    name: '季宝-2',
    description: '季宝 2.0 经典图像生成',
    ratios: WORKRALLY_IMAGE_RATIOS_EXTENDED,
    resolutions: [RES_1K, RES_2K, RES_4K],
    qualities: QUALITY_3,
  },
  {
    id: 'dxf3xs1t2l',
    name: 'Seedream-4',
    description: 'Seedream 4 稳定图像生成',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K, RES_4K],
  },
  {
    id: 'a9lj0xftam',
    name: '美宝-6.1',
    description: '美宝 6.1 电影感视觉生成',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K],
  },
  {
    id: 'epejduyxsr',
    name: '美宝-8.1',
    description: '美宝 8.1 真实感与艺术渲染',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K, RES_2K],
  },
  {
    id: 'ehrw7lrj74',
    name: '美宝-Niji 7',
    description: '美宝 Niji 7 二次元动漫与插画',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1K],
  },
  {
    id: 'w02eww5li4',
    name: 'Qwen-Image-3.0',
    description: '通义千问图像生成 3.0',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1080P, RES_2K],
  },
  {
    id: '6cu0lcwkz4',
    name: 'Qwen-Image-3.0 Pro',
    description: '通义千问图像生成 3.0 Pro 专业版',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1080P, RES_2K],
  },
  {
    id: 'ygkgqsosdb',
    name: '美宝-8.2',
    description: '美宝 8.2 全新光影质感生图',
    ratios: WORKRALLY_IMAGE_RATIOS_STANDARD,
    resolutions: [RES_1080P, RES_2K],
  },
];
