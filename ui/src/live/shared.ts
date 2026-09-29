import {PreferredCodec} from '../settings';

export interface LiveInfo {
    type: 'info';
    mimeType: string;
    videoCodec: string;
    width: number;
    height: number;
    hasAudio: boolean;
    /** Framerate the host is capturing/encoding at. */
    fps: number;
}

export interface LiveViewers {
    type: 'viewers';
    count: number;
}

export const liveWsURL = (id: string, role: 'host' | 'viewer', token: string): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/live/ws?id=${encodeURIComponent(
        id
    )}&role=${role}&token=${encodeURIComponent(token)}`;
};

export interface LiveCodecCandidate {
    webCodecs: string;
    muxer: 'avc' | 'hevc' | 'av1' | 'vp9';
    label: string;
}

const ALL_CANDIDATES: LiveCodecCandidate[] = [
    {webCodecs: 'avc1.640034', muxer: 'avc', label: 'H.264 High（硬件优先）'},
    {webCodecs: 'hvc1.1.6.L123.B0', muxer: 'hevc', label: 'H.265/HEVC（硬件）'},
    {webCodecs: 'av01.0.09M.08', muxer: 'av1', label: 'AV1'},
    {webCodecs: 'vp09.00.51.08', muxer: 'vp9', label: 'VP9'},
];

// Live mode pushes through a server, so there is no SDP negotiation with the
// viewer: the host picks the codec and viewers need to be able to decode it.
// H.264 High hardware first: universally decodable, cheap to encode and with
// generous bitrates it looks great even on WAN links.
export const resolveLiveCodecCandidates = (preferred?: PreferredCodec): LiveCodecCandidate[] => {
    const mime = preferred?.mimeType;
    const first =
        mime === 'video/H265'
            ? 'hvc1.1.6.L123.B0'
            : mime === 'video/AV1'
              ? 'av01.0.09M.08'
              : mime === 'video/VP9' || mime === 'BEST_QUALITY'
                ? 'vp09.00.51.08'
                : mime === 'video/H264'
                  ? 'avc1.640034'
                  : null;
    if (!first) {
        return ALL_CANDIDATES;
    }
    return [
        ...ALL_CANDIDATES.filter((c) => c.webCodecs === first),
        ...ALL_CANDIDATES.filter((c) => c.webCodecs !== first),
    ];
};

export const liveMimeType = (mseCodec: string, hasAudio: boolean): string =>
    `video/mp4; codecs="${mseCodec}${hasAudio ? ',opus' : ''}"`;

export const getDisplayConstraints = (framerate: number): MediaStreamConstraints =>
    ({
        video: {frameRate: framerate},
        audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
            // Improves tab audio quality; not part of the TS constraint type.
            googAutoGainControl: false,
        },
    }) as MediaStreamConstraints;
