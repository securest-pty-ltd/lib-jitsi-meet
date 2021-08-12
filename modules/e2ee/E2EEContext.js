/* global __filename */

// import { getLogger } from 'jitsi-meet-logger';

// const logger = getLogger(__filename);

// Flag to set on senders / receivers to avoid setting up the encryption transform
// more than once.
const kJitsiE2EE = Symbol('kJitsiE2EE');

const dopLength = 8; // timestamp and synchronizationSource

// For audio (where frame.type is not set) we do not encrypt the opus TOC byte:
//   https://tools.ietf.org/html/rfc6716#section-3.1
const UNENCRYPTED_BYTES = {
    key: 10,
    delta: 3,
    undefined: 1 // frame.type is not set on audio
};

/**
 * Context encapsulating the cryptography bits required for E2EE.
 * This uses the WebRTC Insertable Streams API which is explained in
 *   https://github.com/alvestrand/webrtc-media-streams/blob/master/explainer.md
 * that provides access to the encoded frames and allows them to be transformed.
 *
 * The encoded frame format is explained below in the _encodeFunction method.
 * High level design goals were:
 * - do not require changes to existing SFUs and retain (VP8) metadata.
 * - allow the SFU to rewrite SSRCs, timestamp, pictureId.
 * - allow for the key to be rotated frequently.
 */
export default class E2EEcontext {
    /**
     * Build a new E2EE context instance, which will be used in a given conference.
     */
    constructor() {
        // Determine the URL for the worker script. Relative URLs are relative to
        // the entry point, not the script that launches the worker.
        // let baseUrl = '';
        // const ljm = document.querySelector('script[src*="lib-jitsi-meet"]');

        // if (ljm) {
        //     const idx = ljm.src.lastIndexOf('/');

        //     baseUrl = `${ljm.src.substring(0, idx)}/`;
        // }

        // Initialize the E2EE worker. In order to avoid CORS issues, start the worker and have it
        // synchronously load the JS.
        // const workerUrl = `${baseUrl}lib-jitsi-meet.e2ee-worker.js`;
        // const workerBlob
        //     = new Blob([ `importScripts("${workerUrl}");` ], { type: 'application/javascript' });
        // const blobUrl = window.URL.createObjectURL(workerBlob);

        // this._worker = new Worker(blobUrl, { name: 'E2EE Worker' });
        // this._worker.onerror = e => logger.onerror(e);
    }

    /**
     * Cleans up all state associated with the given participant. This is needed when a
     * participant leaves the current conference.
     *
     * @param {string} participantId - The participant that just left.
     */
    cleanup(participantId) {
        // this._worker.postMessage({
        //     operation: 'cleanup',
        //     participantId
        // });
    }

    /**
     * Handles the given {@code RTCRtpReceiver} by creating a {@code TransformStream} which will inject
     * a frame decoder.
     *
     * @param {RTCRtpReceiver} receiver - The receiver which will get the decoding function injected.
     * @param {string} kind - The kind of track this receiver belongs to.
     * @param {string} participantId - The participant id that this receiver belongs to.
     */
    handleReceiver(receiver, kind, participantId) {
        if (receiver[kJitsiE2EE]) {
            return;
        }
        receiver[kJitsiE2EE] = true;

        const receiverStreams = receiver.createEncodedStreams();

        const transformStream = new TransformStream({
          transform: this._decodeFunction.bind(this)
        });

        receiverStreams.readable
          .pipeThrough(transformStream)
          .pipeTo(receiverStreams.writable);

        // this._worker.postMessage({
        //     operation: 'decode',
        //     readableStream: receiverStreams.readable,
        //     writableStream: receiverStreams.writable,
        //     participantId
        // }, [ receiverStreams.readable, receiverStreams.writable ]);
    }

    /**
     * Handles the given {@code RTCRtpSender} by creating a {@code TransformStream} which will inject
     * a frame encoder.
     *
     * @param {RTCRtpSender} sender - The sender which will get the encoding function injected.
     * @param {string} kind - The kind of track this sender belongs to.
     * @param {string} participantId - The participant id that this sender belongs to.
     */
    handleSender(sender, kind, participantId) {
        if (sender[kJitsiE2EE]) {
            return;
        }
        sender[kJitsiE2EE] = true;

        const senderStreams = sender.createEncodedStreams();

        const transformStream = new TransformStream({
          transform: this._encodeFunction.bind(this)
        });

        senderStreams.readable
          .pipeThrough(transformStream)
          .pipeTo(senderStreams.writable);

        // this._worker.postMessage({
        //     operation: 'encode',
        //     readableStream: senderStreams.readable,
        //     writableStream: senderStreams.writable,
        //     participantId
        // }, [ senderStreams.readable, senderStreams.writable ]);
    }

    /**
     * Set the E2EE key for the specified participant.
     *
     * @param {string} participantId - the ID of the participant who's key we are setting.
     * @param {Uint8Array | boolean} key - they key for the given participant.
     * @param {Number} keyIndex - the key index.
     */
    setKey(participantId, key, keyIndex) {
        // this._worker.postMessage({
        //     operation: 'setKey',
        //     participantId,
        //     key,
        //     keyIndex
        // });
    }

  /**
   * Function that will be injected in a stream and will encrypt the given encoded frames.
   *
   * @param {RTCEncodedVideoFrame|RTCEncodedAudioFrame} encodedFrame - Encoded video frame.
   * @param {TransformStreamDefaultController} controller - TransportStreamController.
   *
   * The packet format is described below. One of the design goals was to not require
   * changes to the SFU which for video requires not encrypting the keyframe bit of VP8
   * as SFUs need to detect a keyframe (framemarking or the generic frame descriptor will
   * solve this eventually). This also "hides" that a client is using E2EE a bit.
   *
   * Note that this operates on the full frame, i.e. for VP8 the data described in
   *   https://tools.ietf.org/html/rfc6386#section-9.1
   *
   * The VP8 payload descriptor described in
   *   https://tools.ietf.org/html/rfc7741#section-4.2
   * is part of the RTP packet and not part of the frame and is not controllable by us.
   * This is fine as the SFU keeps having access to it for routing.
   *
   */

    async _encodeFunction(encodedFrame, controller) {
        const timestamp = encodedFrame.timestamp;
        const synchronizationSource = encodedFrame.getMetadata().synchronizationSource;
        const timestampBuffer = new ArrayBuffer(dopLength);
        const timestampView = new DataView(timestampBuffer);

        timestampView.setUint32(0, timestamp);
        timestampView.setUint32(4, synchronizationSource);

        const dekkoEncryptedData = await this.dekko.encrypt({
          data: encodedFrame.data.slice(UNENCRYPTED_BYTES[encodedFrame.type]),
          timestamp,
          synchronizationSource,
        });

        if (!dekkoEncryptedData) {
            return;
        }

        const newData = new ArrayBuffer(UNENCRYPTED_BYTES[encodedFrame.type] + dekkoEncryptedData.byteLength + dopLength);
        const newUint8 = new Uint8Array(newData);
        newUint8.set(new Uint8Array(encodedFrame.data, 0, UNENCRYPTED_BYTES[encodedFrame.type])); // copy first bytes.
        newUint8.set(new Uint8Array(dekkoEncryptedData), UNENCRYPTED_BYTES[encodedFrame.type]); // add ciphertext.
        newUint8.set(
          new Uint8Array(timestampBuffer), UNENCRYPTED_BYTES[encodedFrame.type] + dekkoEncryptedData.byteLength
        ); // timestamp

        encodedFrame.data = newData;

        return controller.enqueue(encodedFrame);
    }
    /**
    * Function that will be injected in a stream and will decrypt the given encoded frames.
    *
    * @param {RTCEncodedVideoFrame|RTCEncodedAudioFrame} encodedFrame - Encoded video frame.
    * @param {TransformStreamDefaultController} controller - TransportStreamController.
    *
    */


    async _decodeFunction(encodedFrame, controller) {
        try {
            const timestampBuffer = encodedFrame.data.slice(-dopLength);
            const timestampView = new DataView(timestampBuffer);
            const timestamp = timestampView.getUint32(0);
            const synchronizationSource = timestampView.getUint32(4);

            const stop = encodedFrame.data.byteLength - dopLength;
            const start = UNENCRYPTED_BYTES[encodedFrame.type];
            const data = encodedFrame.data.slice(start, stop);

            const dekkoDecryptedData = await this.dekko.decrypt({
              data,
              timestamp,
              synchronizationSource,
            })
            const newData = new ArrayBuffer(UNENCRYPTED_BYTES[encodedFrame.type] + dekkoDecryptedData.byteLength);
            const newUint8 = new Uint8Array(newData);
            newUint8.set(new Uint8Array(encodedFrame.data, 0, UNENCRYPTED_BYTES[encodedFrame.type]));
            newUint8.set(new Uint8Array(dekkoDecryptedData), UNENCRYPTED_BYTES[encodedFrame.type]);
            encodedFrame.data = newData;
        } catch (err) {
            console.error(err, 'decrypt error frame');
        }

        return controller.enqueue(encodedFrame);
    }
}
