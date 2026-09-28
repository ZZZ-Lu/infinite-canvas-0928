import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpKey } from './useMcpKey';
import {
  WORKRALLY_IMAGE_MODELS,
  WORKRALLY_IMAGE_RATIOS,
  WORKRALLY_IMAGE_TOOL,
  WorkRallyImageModel,
} from '../config/workrallyImageModels';
import {
  WORKRALLY_VIDEO_MODELS,
  WORKRALLY_VIDEO_RATIOS,
  WORKRALLY_VIDEO_TOOL,
  WorkRallyVideoModel,
} from '../config/workrallyVideoModels';

export interface DynamicModelResult {
  models: (WorkRallyImageModel | WorkRallyVideoModel)[];
  ratios: string[];
  resolutions: string[];
  toolName: string;
  isDynamic: boolean;
  fetchedAt: number;
}

// Global cache keyed by: `${keyId || 'anon'}_${isVideo ? 'video' : 'image'}`
const modelCache = new Map<string, DynamicModelResult>();
const subscribers = new Set<() => void>();

function notifySubscribers() {
  subscribers.forEach(cb => {
    try {
      cb();
    } catch (e) {
      console.error('WorkRally models subscriber error:', e);
    }
  });
}

export function subscribeWorkrallyModels(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Fetch dynamic models from WorkRally MCP server
 */
export async function fetchWorkrallyModels(
  token: string,
  serverUrl: string,
  isVideo: boolean,
  forceRefresh = false
): Promise<DynamicModelResult> {
  const cacheKey = `${token}_${isVideo ? 'video' : 'image'}`;
  
  if (!forceRefresh && modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey)!;
  }

  const defaultModels = isVideo ? WORKRALLY_VIDEO_MODELS : WORKRALLY_IMAGE_MODELS;
  const defaultRatios = isVideo ? WORKRALLY_VIDEO_RATIOS : WORKRALLY_IMAGE_RATIOS;
  const defaultTool = isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL;

  if (!token) {
    const fallback: DynamicModelResult = {
      models: defaultModels,
      ratios: defaultRatios,
      resolutions: isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K'],
      toolName: defaultTool,
      isDynamic: false,
      fetchedAt: Date.now(),
    };
    modelCache.set(cacheKey, fallback);
    return fallback;
  }

  try {
    const response = await fetch('/api/mcp/workrally/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, serverUrl, isVideo }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.success && Array.isArray(data.models) && data.models.length > 0) {
      const result: DynamicModelResult = {
        models: data.models,
        ratios: data.ratios && data.ratios.length > 0 ? data.ratios : defaultRatios,
        resolutions: data.resolutions && data.resolutions.length > 0 ? data.resolutions : (isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K']),
        toolName: data.toolName || (data.generationTool?.name) || defaultTool,
        isDynamic: true,
        fetchedAt: Date.now(),
      };
      modelCache.set(cacheKey, result);
      notifySubscribers();
      return result;
    }
  } catch (error) {
    console.warn('Failed to fetch dynamic models from WorkRally:', error);
  }

  const fallback: DynamicModelResult = {
    models: defaultModels,
    ratios: defaultRatios,
    resolutions: isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K'],
    toolName: defaultTool,
    isDynamic: false,
    fetchedAt: Date.now(),
  };
  modelCache.set(cacheKey, fallback);
  return fallback;
}

export function clearWorkrallyModelsCache() {
  modelCache.clear();
  notifySubscribers();
}

/**
 * Hook to retrieve the current image/video models list dynamically synchronized with WorkRally MCP tools
 */
export function useWorkrallyModels(isVideo: boolean) {
  const { activeKey } = useMcpKey();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultModels = isVideo ? WORKRALLY_VIDEO_MODELS : WORKRALLY_IMAGE_MODELS;
  const defaultRatios = isVideo ? WORKRALLY_VIDEO_RATIOS : WORKRALLY_IMAGE_RATIOS;
  const defaultTool = isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL;

  const cacheKey = `${activeKey?.token || 'anon'}_${isVideo ? 'video' : 'image'}`;
  const cached = modelCache.get(cacheKey);

  const [state, setState] = useState<DynamicModelResult>(
    cached || {
      models: defaultModels,
      ratios: defaultRatios,
      resolutions: isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K'],
      toolName: defaultTool,
      isDynamic: false,
      fetchedAt: 0,
    }
  );

  const isFetchingRef = useRef(false);

  const loadModels = useCallback(async (force = false) => {
    if (!activeKey?.token) {
      setState({
        models: defaultModels,
        ratios: defaultRatios,
        resolutions: isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K'],
        toolName: defaultTool,
        isDynamic: false,
        fetchedAt: Date.now(),
      });
      return;
    }

    if (isFetchingRef.current && !force) return;
    isFetchingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetchWorkrallyModels(
        activeKey.token,
        activeKey.serverUrl,
        isVideo,
        force
      );
      setState(res);
    } catch (err: any) {
      setError(err.message || '获取模型列表失败');
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [activeKey?.token, activeKey?.serverUrl, isVideo]);

  // Listen to global model cache updates
  useEffect(() => {
    const unsubscribe = subscribeWorkrallyModels(() => {
      const currentCached = modelCache.get(cacheKey);
      if (currentCached) {
        setState(currentCached);
      }
    });
    return unsubscribe;
  }, [cacheKey]);

  // Initial load or token switch
  useEffect(() => {
    const currentCached = modelCache.get(cacheKey);
    if (currentCached) {
      setState(currentCached);
    } else if (activeKey?.token) {
      loadModels(false);
    }
  }, [cacheKey, activeKey?.token, loadModels]);

  const refresh = useCallback(async () => {
    await loadModels(true);
  }, [loadModels]);

  return {
    models: state.models,
    ratios: state.ratios,
    resolutions: state.resolutions,
    toolName: state.toolName,
    isDynamic: state.isDynamic,
    isLoading,
    error,
    refresh,
    activeKey,
  };
}
