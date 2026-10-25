// Storage DTOs contain resource IDs, never runtime blob URLs.
export interface Resource { id: string; value: Blob | string }
export interface EncodedCard { id: string; data: any; resources: string[]; base?: any }
const marker = '__infiniteCanvasResource';
export class CardCodec {
  private blobs = new WeakMap<Blob, string>();
  private strings = new Map<string, string>();
  private objects = new WeakMap<object, any>();
  private resources = new Map<string, Blob | string>();
  private uploaded = new Set<string>();

  private reference(value: Blob | string, format: string) {
    let id = value instanceof Blob ? this.blobs.get(value) : this.strings.get(value);
    if (!id) {
      id = crypto.randomUUID();
      if (value instanceof Blob) this.blobs.set(value, id);
      else this.strings.set(value, id);
      this.resources.set(id, value);
    }
    return { [marker]: id, format };
  }

  async encode(value: any): Promise<any> {
    if (value instanceof Blob) return this.reference(value, 'blob');
    if (typeof value === 'string') {
      if (value.startsWith('data:')) return this.reference(value, 'data');
      if (value.startsWith('blob:')) {
        let id = this.strings.get(value);
        if (!id) {
          try {
            const response = await fetch(value);
            if (!response.ok) throw new Error('图片资源无法读取，已保留待保存数据');
            const ref = this.reference(await response.blob(), 'url');
            id = ref[marker];
            this.strings.set(value, id);
          } catch (err) {
            throw new Error('图片资源无法读取，已保留待保存数据');
          }
        }
        return { [marker]: id, format: 'url' };
      }
      return value;
    }
    if (!value || typeof value !== 'object') return value;
    const cached = this.objects.get(value);
    if (cached) return cached;
    const result: any = Array.isArray(value) ? [] : {};
    // Register known URL/Blob pairs to avoid fetching the same runtime resource.
    for (const [urlKey, blobKey] of [
      ['imageUrl', 'fileData'], ['originalImageUrl', 'originalFileData'],
      ['trueOriginalImageUrl', 'trueOriginalFileData'], ['url', 'fileData'],
      ['referenceImageUrl', 'referenceImageFileData'],
    ]) {
      if (typeof value[urlKey] === 'string' && value[urlKey].startsWith('blob:') && value[blobKey] instanceof Blob) {
        this.strings.set(value[urlKey], this.reference(value[blobKey], 'blob')[marker]);
      }
    }
    for (const key of Object.keys(value)) result[key] = await this.encode(value[key]);
    this.objects.set(value, result);
    return result;
  }

  async card(card: any): Promise<EncodedCard> {
    const data = await this.encode(card);
    const ids = new Set<string>();
    const visit = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (typeof v[marker] === 'string') { ids.add(v[marker]); return; }
      Object.values(v).forEach(visit);
    };
    visit(data);
    return { id: card.id, data, resources: [...ids] };
  }
  pending(ids: string[]): Resource[] {
    return [...new Set(ids)].filter(id => !this.uploaded.has(id)).map(id => {
      const value = this.resources.get(id);
      if (value === undefined) throw new Error(`缺少图片资源 ${id}`);
      return { id, value };
    });
  }
  accept(resources: Resource[]) {
    for (const { id, value } of resources) {
      this.resources.set(id, value);
      this.uploaded.add(id);
      if (value instanceof Blob) this.blobs.set(value, id);
      else this.strings.set(value, id);
    }
  }
  decode(value: any): any {
    if (!value || typeof value !== 'object') return value;
    if (typeof value[marker] === 'string') {
      const resource = this.resources.get(value[marker]);
      if (resource === undefined || resource === null) return null;
      if (value.format !== 'url') return resource;
      if (!(resource instanceof Blob)) return null;
      // Reuse an object URL for all references to this resource.
      const key = `url:${value[marker]}`;
      let url = this.strings.get(key);
      if (!url) {
        url = URL.createObjectURL(resource);
        this.strings.set(key, url);
        this.strings.set(url, value[marker]);
      }
      return url;
    }
    const decoded: any = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) decoded[key] = this.decode(value[key]);
    return decoded;
  }
}
