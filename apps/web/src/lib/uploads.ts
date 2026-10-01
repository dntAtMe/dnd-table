export interface Uploaded {
  id: string;
  url: string;
  kind: 'image' | 'audio';
  mime: string;
}

/** Uploads a file as the raw request body (GM only); the server sniffs what it is. */
export async function uploadFile(campaignId: string, file: File): Promise<Uploaded> {
  const res = await fetch(`/api/campaigns/${campaignId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as Partial<Uploaded> & { error?: string };
  if (!res.ok || !data.id) throw new Error(data.error ?? 'Upload failed');
  return data as Uploaded;
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const AUDIO_ACCEPT = 'audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.flac';
