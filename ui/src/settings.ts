import React from 'react';
export const CodecAuto: PreferredCodec = {mimeType: 'AUTO'};
export const CodecBestQuality: PreferredCodec = {mimeType: 'BEST_QUALITY'};
export const CodecDefault: PreferredCodec = {mimeType: 'DEFAULT'};

export const preferCodecEquals = (a: PreferredCodec, b: PreferredCodec): boolean => {
    return a.mimeType === b.mimeType && a.sdpFmtpLine === b.sdpFmtpLine;
};

export const codecName = (mimeType: string): string => {
    switch (mimeType) {
        case CodecAuto.mimeType:
            return '自动（推荐）';
        case CodecBestQuality.mimeType:
            return '预设：最佳画质';
        case CodecDefault.mimeType:
            return '预设：浏览器默认';
        default:
            return mimeType;
    }
};

export const displayModeName = (mode: VideoDisplayMode): string => {
    switch (mode) {
        case VideoDisplayMode.FitToWindow:
            return '适应窗口';
        case VideoDisplayMode.FitWidth:
            return '适应宽度';
        case VideoDisplayMode.FitHeight:
            return '适应高度';
        case VideoDisplayMode.OriginalSize:
            return '原始大小';
        default:
            return mode;
    }
};

export const resolveCodecPlaceholder = (
    codec: PreferredCodec | undefined
): PreferredCodec | undefined => {
    switch (codec?.mimeType) {
        case CodecBestQuality.mimeType:
            return {
                mimeType: 'video/VP9',
                sdpFmtpLine: 'profile-id=2',
            };
        case CodecDefault.mimeType:
            return undefined;
        default:
            return codec;
    }
};

// Auto prefers the codec that is most likely to actually produce a picture on
// both ends. H.264 comes first: it is hardware encoded/decoded essentially
// everywhere (and is what the live pipeline already uses successfully). H.265
// and AV1 look better on paper, but they negotiate a codec whose hardware
// encoder is often missing or busy — or a software AV1 encoder too slow for a
// realtime 1080p stream — and the viewer then sees nothing at all. This only
// REORDERS the offer: the viewing side still answers with what it can decode.
const AutoCodecPriority = ['video/H264', 'video/H265', 'video/VP9', 'video/AV1', 'video/VP8'];

export const buildPreferredCodecs = (
    available: RTCRtpCodec[],
    preferred: PreferredCodec | undefined
): RTCRtpCodec[] | undefined => {
    if (!preferred || preferred.mimeType === CodecDefault.mimeType) {
        return undefined;
    }
    const score = (codec: RTCRtpCodec): number => {
        if (preferred.mimeType === CodecAuto.mimeType) {
            const index = AutoCodecPriority.indexOf(codec.mimeType);
            return index === -1 ? AutoCodecPriority.length : index;
        }
        if (codec.mimeType === preferred.mimeType) {
            if (preferred.sdpFmtpLine && codec.sdpFmtpLine === preferred.sdpFmtpLine) {
                return 0;
            }
            return 1;
        }
        return 2;
    };
    return [...available].sort((a, b) => score(a) - score(b));
};

export interface Settings {
    name?: string;
    displayMode: VideoDisplayMode;
    preferCodec?: PreferredCodec;
    /** 0 = auto: live follows the effective bitrate (60fps at >=15M), realtime 30. */
    framerate: number;
    bitrateMbps: number;
    liveBitrateMbps: number;
    /** When true, the live bitrate follows the server's configured bandwidth. */
    liveBitrateAuto: boolean;
    liveBufferSeconds: number;
}

/** Live captures at 60fps once the effective live bitrate reaches this. */
export const LiveFramerateAutoThresholdMbps = 15;

export const resolveLiveFramerate = (framerate: number, liveMbps: number): number => {
    if (framerate > 0) {
        return framerate;
    }
    return liveMbps >= LiveFramerateAutoThresholdMbps ? 60 : 30;
};

// Realtime (room) mode pursues clarity at a given bitrate, so auto stays 30.
export const resolveRoomFramerate = (framerate: number): number =>
    framerate > 0 ? framerate : 30;
export interface PreferredCodec {
    mimeType: string;
    sdpFmtpLine?: string;
}

export enum VideoDisplayMode {
    FitToWindow = 'FitToWindow',
    FitWidth = 'FitWidth',
    FitHeight = 'FitHeight',
    OriginalSize = 'OriginalSize',
}

const SettingsKey = 'screegoSettings';
const SettingsVersionKey = 'screegoSettingsVersion';
// v2: framerate 0 means auto; releases before stored the old default (30),
// which must not pin auto users to 30 — migrate it once.
const SettingsVersion = 2;
const LegacyDefaultFramerate = 30;

export const loadSettings = (): Settings => {
    const settings: Partial<Settings> = JSON.parse(localStorage.getItem(SettingsKey) ?? '{}') ?? {};

    const defaults: Settings = {
        displayMode: VideoDisplayMode.FitToWindow,
        framerate: 0,
        bitrateMbps: 15,
        // Live mode always flows through the server; the concrete default is
        // advertised by the server via /config (liveBitrateAuto).
        liveBitrateMbps: 4,
        liveBitrateAuto: true,
        liveBufferSeconds: 0,
    };

    if (settings && typeof settings === 'object') {
        const versionSeen = localStorage.getItem(SettingsVersionKey) === String(SettingsVersion);
        const migrated = !versionSeen && settings.framerate === LegacyDefaultFramerate;
        const merged: Settings = {
            name: settings.name?.toString(),
            framerate: migrated ? defaults.framerate : (settings.framerate ?? defaults.framerate),
            bitrateMbps: settings.bitrateMbps ?? defaults.bitrateMbps,
            liveBitrateMbps: settings.liveBitrateMbps ?? defaults.liveBitrateMbps,
            liveBitrateAuto: settings.liveBitrateAuto ?? defaults.liveBitrateAuto,
            liveBufferSeconds: Math.min(4, Math.max(0, settings.liveBufferSeconds ?? 0)),
            displayMode:
                Object.values(VideoDisplayMode).find((mode) => mode === settings.displayMode) ??
                defaults.displayMode,
            preferCodec: settings.preferCodec ?? CodecAuto,
        };
        if (!versionSeen) {
            localStorage.setItem(SettingsVersionKey, String(SettingsVersion));
        }
        if (migrated) {
            saveSettings(merged);
        }
        return merged;
    }
    return defaults;
};

export const saveSettings = (settings: Settings): void => {
    localStorage.setItem(SettingsKey, JSON.stringify(settings));
};

export const useSettings = (): [Settings, (s: Settings) => void] => {
    const [settings, setSettings] = React.useState(loadSettings);

    return [
        settings,
        (newSettings) => {
            setSettings(newSettings);
            saveSettings(newSettings);
        },
    ];
};
