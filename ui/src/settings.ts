import React from 'react';
export const CodecBestQuality: PreferredCodec = {mimeType: 'BEST_QUALITY'};
export const CodecDefault: PreferredCodec = {mimeType: 'DEFAULT'};

export const preferCodecEquals = (a: PreferredCodec, b: PreferredCodec): boolean => {
    return a.mimeType === b.mimeType && a.sdpFmtpLine === b.sdpFmtpLine;
};

export const codecName = (mimeType: string): string => {
    switch (mimeType) {
        case CodecBestQuality.mimeType:
            return 'Preset: Best Quality';
        case CodecDefault.mimeType:
            return 'Preset: Browser Default';
        default:
            return mimeType;
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

export interface Settings {
    name?: string;
    displayMode: VideoDisplayMode;
    preferCodec?: PreferredCodec;
    framerate: number;
    echoCancellation: boolean;
    noiseSuppression: boolean;
    videoResolution?: VideoResolution;
}
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

export enum VideoResolution {
    DEFAULT = 'Browser Default',
    P1440= '2560*1440P',
    P1080 = '1920*1080P',
    P990 = '1760*990P',
    P900 = '1600*900P',
    P810 = '1440*810P',
    P720 = '1280*720P',
    P540 = '960*540P',
    P480 = '640*480P'
}

export const resolveVideoResolutionWidth = (codec: VideoResolution | undefined): number => {
    switch (codec) {
        case VideoResolution.P1440:
            return 1440;
        case VideoResolution.P1080:
            return 1080;
        case VideoResolution.P990:
            return 990;
        case VideoResolution.P900:
            return 900;
        case VideoResolution.P810:
            return 810;
        case VideoResolution.P720:
            return 720;
        case VideoResolution.P540:
            return 540;
        case VideoResolution.P480:
            return 480;
        default:
            return 1080;
    }
};

export const resolveVideoResolutionHeight = (codec: VideoResolution | undefined): number => {
    switch (codec) {
        case VideoResolution.P1440:
            return 2560;
        case VideoResolution.P1080:
            return 1920;
        case VideoResolution.P990:
            return 1760;
        case VideoResolution.P900:
            return 1600;
        case VideoResolution.P810:
            return 1440;
        case VideoResolution.P720:
            return 1080;
        case VideoResolution.P540:
            return 960;
        case VideoResolution.P480:
            return 640;
        default:
            return 1920;
    }
};


const SettingsKey = 'screegoSettings';

export const loadSettings = (): Settings => {
    const settings: Partial<Settings> = JSON.parse(localStorage.getItem(SettingsKey) ?? '{}') ?? {};

    const defaults: Settings = {
        displayMode: VideoDisplayMode.FitToWindow,
        framerate: 30,
        noiseSuppression: false,
        echoCancellation: false,
        videoResolution: VideoResolution.DEFAULT,
    };

    if (settings && typeof settings === 'object') {
        return {
            name: settings.name?.toString(),
            framerate: settings.framerate ?? defaults.framerate,
            displayMode:
                Object.values(VideoDisplayMode).find((mode) => mode === settings.displayMode) ??
                defaults.displayMode,
            preferCodec: settings.preferCodec ?? CodecDefault,
            noiseSuppression: settings.noiseSuppression ?? defaults.noiseSuppression,
            echoCancellation: settings.echoCancellation ?? defaults.echoCancellation,
            videoResolution:
                Object.values(VideoResolution).find((mode) => mode === settings.videoResolution) ??
                defaults.videoResolution,
        };
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
