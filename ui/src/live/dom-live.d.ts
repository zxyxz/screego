// MediaStreamTrackProcessor (Insertable Streams) is Chrome-specific and not
// part of TypeScript's DOM lib yet.
declare class MediaStreamTrackProcessor {
    constructor(init: {track: MediaStreamTrack});
    readonly readable: ReadableStream<any>;
}
