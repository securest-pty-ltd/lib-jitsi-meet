import { KeyHandler } from './KeyHandler';
import { JitsiConferenceEvents } from '../../JitsiConferenceEvents';

/**
 * This module integrates {@link E2EEContext} with {external} in order to set the keys for encryption.
 */
export class ExternallyManagedKeyHandler extends KeyHandler {
    /**
     * Build a new ExternallyManagedKeyHandler instance, which will be used in a given conference.
     * @param conference - the current conference.
     */
    constructor(conference) {
        super(conference, { sharedKey: true });

        this.conference.on(
            JitsiConferenceEvents.USER_LEFT,
            this._onParticipantLeft.bind(this));        
    }

    /**
     * Sets the key and index for End-to-End encryption.
     *
     * @param {CryptoKey} [keyInfo.encryptionKey] - encryption key.
     * @param {Number} [keyInfo.index] - the index of the encryption key.
     * @returns {void}
     */
    setKey(keyInfo) {
        // this.e2eeCtx.setKey(undefined, { encryptionKey: keyInfo.encryptionKey }, keyInfo.index);
    }

    /**
     * Rotates the current key when a participant leaves the conference.
     * @private
     */
    _onParticipantLeft(id) {
        this.e2eeCtx.cleanup(id);
    }    
}
