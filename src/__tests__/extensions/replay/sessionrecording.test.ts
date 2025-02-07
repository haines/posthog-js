/// <reference lib="dom" />

import { loadScript } from '../../../utils'
import { PostHogPersistence } from '../../../posthog-persistence'
import {
    CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE,
    SESSION_RECORDING_ENABLED_SERVER_SIDE,
    SESSION_RECORDING_IS_SAMPLED,
    SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE,
} from '../../../constants'
import { SessionIdManager } from '../../../sessionid'
import {
    FULL_SNAPSHOT_EVENT_TYPE,
    INCREMENTAL_SNAPSHOT_EVENT_TYPE,
    META_EVENT_TYPE,
} from '../../../extensions/replay/sessionrecording-utils'
import { PostHog } from '../../../posthog-core'
import { DecideResponse, PostHogConfig, Property, SessionIdChangedCallback } from '../../../types'
import { uuidv7 } from '../../../uuidv7'
import Mock = jest.Mock
import {
    RECORDING_IDLE_ACTIVITY_TIMEOUT_MS,
    RECORDING_MAX_EVENT_SIZE,
    SessionRecording,
} from '../../../extensions/replay/sessionrecording'
import { assignableWindow } from '../../../utils/globals'

// Type and source defined here designate a non-user-generated recording event

jest.mock('../../../utils', () => ({
    ...jest.requireActual('../../../utils'),
    loadScript: jest.fn((_path, callback) => callback()),
}))
jest.mock('../../../config', () => ({ LIB_VERSION: 'v0.0.1' }))

const EMPTY_BUFFER = {
    data: [],
    sessionId: null,
    size: 0,
    windowId: null,
}

const createFullSnapshot = (event = {}) => ({
    type: FULL_SNAPSHOT_EVENT_TYPE,
    data: {},
    ...event,
})

const createIncrementalSnapshot = (event = {}) => ({
    type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
    data: {
        source: 1,
    },
    ...event,
})

function makeDecideResponse(partialResponse: Partial<DecideResponse>) {
    return partialResponse as unknown as DecideResponse
}

describe('SessionRecording', () => {
    const _addCustomEvent = jest.fn()
    let _emit: any
    let posthog: PostHog
    let sessionRecording: SessionRecording
    let sessionId: string
    let sessionManager: SessionIdManager
    let config: PostHogConfig
    let sessionIdGeneratorMock: Mock
    let windowIdGeneratorMock: Mock
    let onFeatureFlagsCallback: ((flags: string[]) => void) | null

    beforeEach(() => {
        assignableWindow.rrwebRecord = jest.fn(({ emit }) => {
            _emit = emit
            return () => {}
        })
        assignableWindow.rrwebRecord.takeFullSnapshot = jest.fn(() => {
            // we pretend to be rrweb and call emit
            _emit(createFullSnapshot())
        })
        assignableWindow.rrwebRecord.addCustomEvent = _addCustomEvent

        assignableWindow.rrwebConsoleRecord = {
            getRecordConsolePlugin: jest.fn(),
        }

        sessionId = 'sessionId' + uuidv7()

        config = {
            api_host: 'https://test.com',
            disable_session_recording: false,
            enable_recording_console_log: false,
            autocapture: false, // Assert that session recording works even if `autocapture = false`
            session_recording: {
                maskAllInputs: false,
            },
            persistence: 'memory',
        } as unknown as PostHogConfig

        sessionIdGeneratorMock = jest.fn().mockImplementation(() => sessionId)
        windowIdGeneratorMock = jest.fn().mockImplementation(() => 'windowId')

        const postHogPersistence = new PostHogPersistence(config)
        postHogPersistence.clear()

        sessionManager = new SessionIdManager(config, postHogPersistence, sessionIdGeneratorMock, windowIdGeneratorMock)

        posthog = {
            get_property: (property_key: string): Property | undefined => {
                return postHogPersistence?.['props'][property_key]
            },
            config: config,
            capture: jest.fn(),
            persistence: postHogPersistence,
            onFeatureFlags: (cb: (flags: string[]) => void) => {
                onFeatureFlagsCallback = cb
            },
            sessionManager: sessionManager,
            _addCaptureHook: jest.fn(),
        } as unknown as PostHog

        // defaults
        posthog.persistence?.register({
            [SESSION_RECORDING_ENABLED_SERVER_SIDE]: true,
            [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v2',
            [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: false,
            [SESSION_RECORDING_IS_SAMPLED]: undefined,
        })

        sessionRecording = new SessionRecording(posthog)
    })

    describe('isRecordingEnabled', () => {
        it('is enabled if both the server and client config says enabled', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: true })
            expect(sessionRecording['isRecordingEnabled']).toBeTruthy()
        })

        it('is disabled if the server is disabled', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: false })
            expect(sessionRecording['isRecordingEnabled']).toBe(false)
        })

        it('is disabled if the client config is disabled', () => {
            posthog.config.disable_session_recording = true
            expect(sessionRecording['isRecordingEnabled']).toBe(false)
        })
    })

    describe('isConsoleLogCaptureEnabled', () => {
        it('uses client side setting when set to false', () => {
            posthog.persistence?.register({ [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: true })
            posthog.config.enable_recording_console_log = false
            expect(sessionRecording['isConsoleLogCaptureEnabled']).toBe(false)
        })

        it('uses client side setting when set to true', () => {
            posthog.persistence?.register({ [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: false })
            posthog.config.enable_recording_console_log = true
            expect(sessionRecording['isConsoleLogCaptureEnabled']).toBe(true)
        })

        it('uses server side setting if client side setting is not set', () => {
            posthog.config.enable_recording_console_log = undefined
            posthog.persistence?.register({ [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: false })
            expect(sessionRecording['isConsoleLogCaptureEnabled']).toBe(false)

            posthog.persistence?.register({ [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: true })
            expect(sessionRecording['isConsoleLogCaptureEnabled']).toBe(true)
        })
    })

    describe('getRecordingVersion', () => {
        it('uses client side setting v2 over server side', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v1' })
            posthog.config.session_recording.recorderVersion = 'v2'
            expect(sessionRecording['recordingVersion']).toBe('v2')
        })

        it('uses client side setting v1 over server side', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v2' })
            posthog.config.session_recording.recorderVersion = 'v1'
            expect(sessionRecording['recordingVersion']).toBe('v1')
        })

        it('uses server side setting if client side setting is not set', () => {
            posthog.config.session_recording.recorderVersion = undefined

            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v1' })
            expect(sessionRecording['recordingVersion']).toBe('v1')

            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v2' })
            expect(sessionRecording['recordingVersion']).toBe('v2')

            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: undefined })
            expect(sessionRecording['recordingVersion']).toBe('v1')
        })
    })

    describe('startRecordingIfEnabled', () => {
        beforeEach(() => {
            // need to cast as any to mock private methods
            jest.spyOn(sessionRecording as any, 'startCaptureAndTrySendingQueuedSnapshots')
            jest.spyOn(sessionRecording, 'stopRecording')
            jest.spyOn(sessionRecording as any, '_tryAddCustomEvent')
        })

        it('call startCaptureAndTrySendingQueuedSnapshots if its enabled', () => {
            sessionRecording.startRecordingIfEnabled()
            expect((sessionRecording as any).startCaptureAndTrySendingQueuedSnapshots).toHaveBeenCalled()
        })

        it('emits an options event', () => {
            sessionRecording.startRecordingIfEnabled()
            expect((sessionRecording as any)['_tryAddCustomEvent']).toHaveBeenCalledWith('$session_options', {
                activePlugins: [],
                sessionRecordingOptions: {
                    blockClass: 'ph-no-capture',
                    blockSelector: undefined,
                    collectFonts: false,
                    ignoreClass: 'ph-ignore-input',
                    inlineStylesheet: true,
                    maskAllInputs: false,
                    maskInputFn: undefined,
                    maskInputOptions: {},
                    maskTextClass: 'ph-mask',
                    maskTextFn: undefined,
                    maskTextSelector: undefined,
                    recordCrossOriginIframes: false,
                    slimDOMOptions: {},
                },
            })
        })

        it('call stopRecording if its not enabled', () => {
            posthog.config.disable_session_recording = true
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording.stopRecording).toHaveBeenCalled()
        })
    })

    describe('afterDecideResponse()', () => {
        beforeEach(() => {
            jest.spyOn(sessionRecording, 'startRecordingIfEnabled')
        })

        it('buffers snapshots until decide is received and drops them if disabled', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()
            expect(sessionRecording['status']).toBe('buffering')
            expect(sessionRecording['buffer']).toEqual(EMPTY_BUFFER)

            const incrementalSnapshot = createIncrementalSnapshot({ data: { source: 1 } })
            _emit(incrementalSnapshot)
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), incrementalSnapshot],
                sessionId: sessionId,
                size: 50,
                windowId: 'windowId',
            })

            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: undefined }))
            expect(sessionRecording['status']).toBe('disabled')
            expect(sessionRecording['buffer']?.data.length).toEqual(undefined)
            expect(posthog.capture).not.toHaveBeenCalled()
        })

        it('emit is not active until decide is called', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()
            expect(sessionRecording['status']).toBe('buffering')

            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            expect(sessionRecording['status']).toBe('active')
        })

        it('sample rate is null when decide does not return it', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()
            expect(sessionRecording['isSampled']).toBe(null)

            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            expect(sessionRecording['isSampled']).toBe(null)
        })

        it('stores true in persistence if recording is enabled from the server', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: undefined })

            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))

            expect(posthog.get_property(SESSION_RECORDING_ENABLED_SERVER_SIDE)).toBe(true)
        })

        it('stores false in persistence if recording is not enabled from the server', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: undefined })

            sessionRecording.afterDecideResponse(makeDecideResponse({}))

            expect(posthog.get_property(SESSION_RECORDING_ENABLED_SERVER_SIDE)).toBe(false)
        })

        it('stores sample rate', () => {
            posthog.persistence?.register({ SESSION_RECORDING_SAMPLE_RATE: undefined })

            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { endpoint: '/s/', sampleRate: '0.70' },
                })
            )

            expect(sessionRecording['_sampleRate']).toBe(0.7)
        })

        it('starts session recording, saves setting and endpoint when enabled', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: undefined })
            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { endpoint: '/ses/' },
                })
            )

            expect(sessionRecording.startRecordingIfEnabled).toHaveBeenCalled()
            expect(loadScript).toHaveBeenCalled()
            expect(posthog.get_property(SESSION_RECORDING_ENABLED_SERVER_SIDE)).toBe(true)
            expect(sessionRecording['_endpoint']).toEqual('/ses/')
        })
    })

    describe('recording', () => {
        describe('sampling', () => {
            it('does not emit to capture if the sample rate is 0', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', sampleRate: '0.00' },
                    })
                )
                expect(sessionRecording['status']).toBe('disabled')

                _emit(createIncrementalSnapshot({ data: { source: 1 } }))
                expect(posthog.capture).not.toHaveBeenCalled()
                expect(sessionRecording['status']).toBe('disabled')
            })

            it('does emit to capture if the sample rate is null', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', sampleRate: null },
                    })
                )

                expect(sessionRecording['status']).toBe('active')
            })

            it('stores excluded session when excluded', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', sampleRate: '0.00' },
                    })
                )

                expect(sessionRecording['isSampled']).toStrictEqual(false)
            })

            it('does emit to capture if the sample rate is 1', () => {
                sessionRecording.startRecordingIfEnabled()

                _emit(createIncrementalSnapshot({ data: { source: 1 } }))
                expect(posthog.capture).not.toHaveBeenCalled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', sampleRate: '1.00' },
                    })
                )
                _emit(createIncrementalSnapshot({ data: { source: 1 } }))

                expect(sessionRecording['status']).toBe('sampled')
                expect(sessionRecording['isSampled']).toStrictEqual(true)

                // don't wait two seconds for the flush timer
                sessionRecording['_flushBuffer']()

                _emit(createIncrementalSnapshot({ data: { source: 1 } }))
                expect(posthog.capture).toHaveBeenCalled()
            })

            it('sets emit as expected when sample rate is 0.5', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', sampleRate: '0.50' },
                    })
                )
                const emitValues: string[] = []
                let lastSessionId = sessionRecording['sessionId']

                for (let i = 0; i < 100; i++) {
                    // force change the session ID
                    sessionManager.resetSessionId()
                    sessionId = 'session-id-' + uuidv7()
                    _emit(createIncrementalSnapshot({ data: { source: 1 } }))

                    expect(sessionRecording['sessionId']).not.toBe(lastSessionId)
                    lastSessionId = sessionRecording['sessionId']

                    emitValues.push(sessionRecording['status'])
                }

                // the random number generator won't always be exactly 0.5, but it should be close
                expect(emitValues.filter((v) => v === 'sampled').length).toBeGreaterThan(30)
                expect(emitValues.filter((v) => v === 'disabled').length).toBeGreaterThan(30)
            })
        })

        describe('canvas', () => {
            it('passes the remote config to rrweb', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', recordCanvas: true, canvasFps: 6, canvasQuality: '0.2' },
                    })
                )
                expect(sessionRecording['_recordCanvas']).toStrictEqual(true)
                expect(sessionRecording['_canvasFps']).toStrictEqual(6)
                expect(sessionRecording['_canvasQuality']).toStrictEqual(0.2)

                sessionRecording['_onScriptLoaded']()
                expect(assignableWindow.rrwebRecord).toHaveBeenCalledWith(
                    expect.objectContaining({
                        recordCanvas: true,
                        sampling: { canvas: 6 },
                        dataURLOptions: {
                            type: 'image/webp',
                            quality: 0.2,
                        },
                    })
                )
            })

            it('skips when any config variable is missing', () => {
                sessionRecording.startRecordingIfEnabled()

                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/', recordCanvas: null, canvasFps: null, canvasQuality: null },
                    })
                )

                sessionRecording['_onScriptLoaded']()

                const mockParams = assignableWindow.rrwebRecord.mock.calls[0][0]
                expect(mockParams).not.toHaveProperty('recordCanvas')
                expect(mockParams).not.toHaveProperty('canvasFps')
                expect(mockParams).not.toHaveProperty('canvasQuality')
            })
        })

        it('calls rrweb.record with the right options', () => {
            posthog.persistence?.register({ [CONSOLE_LOG_RECORDING_ENABLED_SERVER_SIDE]: false })
            // access private method 🤯
            sessionRecording['_onScriptLoaded']()

            // maskAllInputs should change from default
            // someUnregisteredProp should not be present
            expect(assignableWindow.rrwebRecord).toHaveBeenCalledWith({
                emit: expect.anything(),
                maskAllInputs: false,
                blockClass: 'ph-no-capture',
                blockSelector: undefined,
                ignoreClass: 'ph-ignore-input',
                maskTextClass: 'ph-mask',
                maskTextSelector: undefined,
                maskInputOptions: {},
                maskInputFn: undefined,
                slimDOMOptions: {},
                collectFonts: false,
                plugins: [],
                inlineStylesheet: true,
                recordCrossOriginIframes: false,
            })
        })

        it('records events emitted before and after starting recording', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()

            _emit(createIncrementalSnapshot({ data: { source: 1 } }))
            expect(posthog.capture).not.toHaveBeenCalled()

            expect(sessionRecording['buffer']).toEqual({
                data: [
                    createFullSnapshot(),
                    {
                        data: {
                            source: 1,
                        },
                        type: 3,
                    },
                ],
                // session id and window id are not null 🚀
                sessionId: sessionId,
                size: 50,
                windowId: 'windowId',
            })

            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))

            // next call to emit won't flush the buffer
            // the events aren't big enough
            _emit(createIncrementalSnapshot({ data: { source: 2 } }))

            // access private method 🤯so we don't need to wait for the timer
            sessionRecording['_flushBuffer']()
            expect(sessionRecording['buffer']?.data.length).toEqual(undefined)

            expect(posthog.capture).toHaveBeenCalledTimes(1)
            expect(posthog.capture).toHaveBeenCalledWith(
                '$snapshot',
                {
                    $snapshot_bytes: 80,
                    $snapshot_data: [
                        createFullSnapshot(),
                        { type: 3, data: { source: 1 } },
                        { type: 3, data: { source: 2 } },
                    ],
                    $session_id: sessionId,
                    $window_id: 'windowId',
                },
                {
                    method: 'POST',
                    endpoint: '/s/',
                    _noTruncate: true,
                    _batchKey: 'recordings',
                    _metrics: expect.anything(),
                }
            )
        })

        it('buffers emitted events', () => {
            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()

            _emit(createIncrementalSnapshot({ data: { source: 1 } }))
            _emit(createIncrementalSnapshot({ data: { source: 2 } }))

            expect(posthog.capture).not.toHaveBeenCalled()
            expect(sessionRecording['flushBufferTimer']).not.toBeUndefined()

            sessionRecording['_flushBuffer']()
            expect(sessionRecording['flushBufferTimer']).toBeUndefined()

            expect(posthog.capture).toHaveBeenCalledTimes(1)
            expect(posthog.capture).toHaveBeenCalledWith(
                '$snapshot',
                {
                    $session_id: sessionId,
                    $window_id: 'windowId',
                    $snapshot_bytes: 80,
                    $snapshot_data: [
                        createFullSnapshot(),
                        { type: 3, data: { source: 1 } },
                        { type: 3, data: { source: 2 } },
                    ],
                },
                {
                    method: 'POST',
                    endpoint: '/s/',
                    _noTruncate: true,
                    _batchKey: 'recordings',
                    _metrics: expect.anything(),
                }
            )
        })

        it('flushes buffer if the size of the buffer hits the limit', () => {
            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()
            const bigData = 'a'.repeat(RECORDING_MAX_EVENT_SIZE * 0.8)

            _emit(createIncrementalSnapshot({ data: { source: 1, payload: bigData } }))
            _emit(createIncrementalSnapshot({ data: { source: 1, payload: 1 } }))
            _emit(createIncrementalSnapshot({ data: { source: 1, payload: 2 } }))

            expect(posthog.capture).not.toHaveBeenCalled()
            expect(sessionRecording['buffer']).toMatchObject({ size: 755121 })

            // Another big event means the old data will be flushed
            _emit(createIncrementalSnapshot({ data: { source: 1, payload: bigData } }))
            expect(posthog.capture).toHaveBeenCalled()
            expect(sessionRecording['buffer']?.data.length).toEqual(1) // The new event
            expect(sessionRecording['buffer']).toMatchObject({ size: 755017 })
        })

        it('maintains the buffer if the recording is buffering', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()

            const bigData = 'a'.repeat(RECORDING_MAX_EVENT_SIZE * 0.8)

            _emit(createIncrementalSnapshot({ data: { source: 1, payload: bigData } }))
            expect(sessionRecording['buffer']).toMatchObject({ size: 755037 }) // the size of the big data event
            expect(sessionRecording['buffer']?.data.length).toEqual(2) // full snapshot and a big event

            _emit(createIncrementalSnapshot({ data: { source: 1, payload: 1 } }))
            _emit(createIncrementalSnapshot({ data: { source: 1, payload: 2 } }))

            expect(posthog.capture).not.toHaveBeenCalled()
            expect(sessionRecording['buffer']).toMatchObject({ size: 755121 })

            // Another big event means the old data will be flushed
            _emit(createIncrementalSnapshot({ data: { source: 1, payload: bigData } }))
            // but the recording is still buffering
            expect(sessionRecording['status']).toBe('buffering')
            expect(posthog.capture).not.toHaveBeenCalled()
            expect(sessionRecording['buffer']?.data.length).toEqual(5) // + the new event
            expect(sessionRecording['buffer']).toMatchObject({ size: 755037 + 755101 }) // the size of the big data event
        })

        it('flushes buffer if the session_id changes', () => {
            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            sessionRecording.startRecordingIfEnabled()

            expect(sessionRecording['buffer']?.sessionId).toEqual(null)

            _emit(createIncrementalSnapshot({ emit: 1 }))

            expect(posthog.capture).not.toHaveBeenCalled()
            expect(sessionRecording['buffer']?.sessionId).not.toEqual(null)
            expect(sessionRecording['buffer']?.data).toEqual([
                createFullSnapshot(),
                { data: { source: 1 }, emit: 1, type: 3 },
            ])

            // Not exactly right but easier to test than rotating the session id
            // this simulates as the session id changing _after_ it has initially been set
            // i.e. the data in the buffer should be sent with 'otherSessionId'
            sessionRecording['buffer']!.sessionId = 'otherSessionId'
            _emit(createIncrementalSnapshot({ emit: 2 }))

            expect(posthog.capture).toHaveBeenCalledWith(
                '$snapshot',
                {
                    $session_id: 'otherSessionId',
                    $window_id: 'windowId',
                    $snapshot_data: [createFullSnapshot(), { data: { source: 1 }, emit: 1, type: 3 }],
                    $snapshot_bytes: 59,
                },
                {
                    method: 'POST',
                    endpoint: '/s/',
                    _noTruncate: true,
                    _batchKey: 'recordings',
                    _metrics: expect.anything(),
                }
            )

            // and the rrweb event emitted _after_ the session id change should be sent yet
            expect(sessionRecording['buffer']).toEqual({
                data: [
                    {
                        data: {
                            source: 1,
                        },
                        emit: 2,
                        type: 3,
                    },
                ],
                sessionId: sessionId,
                size: 39,
                windowId: 'windowId',
            })
        })

        it("doesn't load recording script if already loaded", () => {
            posthog.__loaded_recorder_version = 'v2'
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).not.toHaveBeenCalled()
        })

        it('loads recording v1 script from right place', () => {
            posthog.config.session_recording.recorderVersion = 'v1'

            sessionRecording.startRecordingIfEnabled()

            expect(loadScript).toHaveBeenCalledWith('https://test.com/static/recorder.js?v=v0.0.1', expect.anything())
        })

        it('loads recording v2 script from right place', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v2' })
            sessionRecording.startRecordingIfEnabled()

            expect(loadScript).toHaveBeenCalledWith(
                'https://test.com/static/recorder-v2.js?v=v0.0.1',
                expect.anything()
            )
        })

        it('load correct recording version if there is a cached mismatch', () => {
            posthog.__loaded_recorder_version = 'v1'
            posthog.persistence?.register({ [SESSION_RECORDING_RECORDER_VERSION_SERVER_SIDE]: 'v2' })
            sessionRecording.startRecordingIfEnabled()

            expect(loadScript).toHaveBeenCalledWith(
                'https://test.com/static/recorder-v2.js?v=v0.0.1',
                expect.anything()
            )
        })

        it('loads script after `startCaptureAndTrySendingQueuedSnapshots` if not previously loaded', () => {
            posthog.persistence?.register({ [SESSION_RECORDING_ENABLED_SERVER_SIDE]: false })

            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).not.toHaveBeenCalled()

            sessionRecording['startCaptureAndTrySendingQueuedSnapshots']()

            expect(loadScript).toHaveBeenCalled()
        })

        it('does not load script if disable_session_recording passed', () => {
            posthog.config.disable_session_recording = true

            sessionRecording.startRecordingIfEnabled()
            sessionRecording['startCaptureAndTrySendingQueuedSnapshots']()

            expect(loadScript).not.toHaveBeenCalled()
        })

        it('session recording can be turned on and off', () => {
            expect(sessionRecording['stopRrweb']).toEqual(undefined)

            sessionRecording.startRecordingIfEnabled()

            expect(sessionRecording.started).toEqual(true)
            expect(sessionRecording['stopRrweb']).not.toEqual(undefined)

            sessionRecording.stopRecording()

            expect(sessionRecording['stopRrweb']).toEqual(undefined)
            expect(sessionRecording.started).toEqual(false)
        })

        it('session recording can be turned on after being turned off', () => {
            expect(sessionRecording['stopRrweb']).toEqual(undefined)

            sessionRecording.startRecordingIfEnabled()

            expect(sessionRecording.started).toEqual(true)
            expect(sessionRecording['stopRrweb']).not.toEqual(undefined)

            sessionRecording.stopRecording()

            expect(sessionRecording['stopRrweb']).toEqual(undefined)
            expect(sessionRecording.started).toEqual(false)
        })

        describe('console logs', () => {
            it('if not enabled, plugin is not used', () => {
                posthog.config.enable_recording_console_log = false

                sessionRecording.startRecordingIfEnabled()

                expect(assignableWindow.rrwebConsoleRecord.getRecordConsolePlugin).not.toHaveBeenCalled()
            })

            it('if enabled, plugin is used', () => {
                posthog.config.enable_recording_console_log = true

                sessionRecording.startRecordingIfEnabled()

                expect(assignableWindow.rrwebConsoleRecord.getRecordConsolePlugin).toHaveBeenCalled()
            })
        })

        describe('session and window ids', () => {
            beforeEach(() => {
                sessionRecording['sessionId'] = 'old-session-id'
                sessionRecording['windowId'] = 'old-window-id'

                sessionRecording.startRecordingIfEnabled()
                sessionRecording.afterDecideResponse(
                    makeDecideResponse({
                        sessionRecording: { endpoint: '/s/' },
                    })
                )
                sessionRecording['startCaptureAndTrySendingQueuedSnapshots']()
            })

            it('sends a full snapshot if there is a new session/window id and the event is not type FullSnapshot or Meta', () => {
                sessionIdGeneratorMock.mockImplementation(() => 'newSessionId')
                windowIdGeneratorMock.mockImplementation(() => 'newWindowId')
                _emit(createIncrementalSnapshot())
                expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalled()
            })

            it('sends a full snapshot if there is a new window id and the event is not type FullSnapshot or Meta', () => {
                sessionIdGeneratorMock.mockImplementation(() => 'old-session-id')
                windowIdGeneratorMock.mockImplementation(() => 'newWindowId')
                _emit(createIncrementalSnapshot())
                expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalled()
            })

            it('does not send a full snapshot if there is a new session/window id and the event is type FullSnapshot or Meta', () => {
                sessionIdGeneratorMock.mockImplementation(() => 'newSessionId')
                windowIdGeneratorMock.mockImplementation(() => 'newWindowId')
                _emit(createIncrementalSnapshot({ type: META_EVENT_TYPE }))
                expect(assignableWindow.rrwebRecord.takeFullSnapshot).not.toHaveBeenCalled()
            })

            it('does not send a full snapshot if there is not a new session or window id', () => {
                assignableWindow.rrwebRecord.takeFullSnapshot.mockClear()

                sessionIdGeneratorMock.mockImplementation(() => 'old-session-id')
                windowIdGeneratorMock.mockImplementation(() => 'old-window-id')
                sessionManager.resetSessionId()

                _emit(createIncrementalSnapshot())
                expect(assignableWindow.rrwebRecord.takeFullSnapshot).not.toHaveBeenCalled()
            })
        })

        describe('the session id manager', () => {
            const startingDate = new Date()

            const emitAtDateTime = (date: Date, source = 1) =>
                _emit({
                    event: 123,
                    type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
                    timestamp: date.getTime(),
                    data: {
                        source,
                    },
                })

            describe('onSessionId Callbacks', () => {
                let mockCallback: Mock<SessionIdChangedCallback>
                let unsubscribeCallback: () => void

                beforeEach(() => {
                    sessionManager = new SessionIdManager(config, new PostHogPersistence(config))
                    posthog.sessionManager = sessionManager

                    mockCallback = jest.fn()
                    unsubscribeCallback = sessionManager.onSessionId(mockCallback)

                    expect(mockCallback).not.toHaveBeenCalled()

                    sessionRecording.startRecordingIfEnabled()
                    sessionRecording['startCaptureAndTrySendingQueuedSnapshots']()

                    expect(mockCallback).toHaveBeenCalledTimes(1)
                })

                it('calls the callback when the session id changes', () => {
                    const startingSessionId = sessionManager['_getSessionId']()[1]
                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    const inactivityThresholdLater = new Date(
                        startingDate.getFullYear(),
                        startingDate.getMonth(),
                        startingDate.getDate(),
                        startingDate.getHours(),
                        startingDate.getMinutes() + 32
                    )
                    emitAtDateTime(inactivityThresholdLater)

                    expect(sessionManager['_getSessionId']()[1]).not.toEqual(startingSessionId)

                    expect(mockCallback).toHaveBeenCalledTimes(2)
                    // last call received the new session id
                    expect(mockCallback.mock.calls[1][0]).toEqual(sessionManager['_getSessionId']()[1])
                })

                it('does not calls the callback when the session id changes after unsubscribe', () => {
                    unsubscribeCallback()

                    const startingSessionId = sessionManager['_getSessionId']()[1]
                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    const inactivityThresholdLater = new Date(
                        startingDate.getFullYear(),
                        startingDate.getMonth(),
                        startingDate.getDate(),
                        startingDate.getHours(),
                        startingDate.getMinutes() + 32
                    )
                    emitAtDateTime(inactivityThresholdLater)

                    expect(sessionManager['_getSessionId']()[1]).not.toEqual(startingSessionId)

                    expect(mockCallback).toHaveBeenCalledTimes(1)
                    // the only call received the original session id
                    expect(mockCallback.mock.calls[0][0]).toEqual(startingSessionId)
                })
            })

            describe('with a real session id manager', () => {
                beforeEach(() => {
                    sessionManager = new SessionIdManager(config, new PostHogPersistence(config))
                    posthog.sessionManager = sessionManager

                    sessionRecording.startRecordingIfEnabled()
                    sessionRecording['startCaptureAndTrySendingQueuedSnapshots']()
                })

                it('takes a full snapshot for the first _emit', () => {
                    emitAtDateTime(startingDate)
                    expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)
                })

                it('does not take a full snapshot for the second _emit', () => {
                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )
                    expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)
                })

                it('does not change session id for a second _emit', () => {
                    const startingSessionId = sessionManager['_getSessionId']()[1]

                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    expect(sessionManager['_getSessionId']()[1]).toEqual(startingSessionId)
                })

                it('does not take a full snapshot for the third _emit', () => {
                    emitAtDateTime(startingDate)

                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 2
                        )
                    )
                    expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)
                })

                it('sends a full snapshot if the session is rotated because session has been inactive for 30 minutes', () => {
                    const startingSessionId = sessionManager['_getSessionId']()[1]
                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    const inactivityThresholdLater = new Date(
                        startingDate.getFullYear(),
                        startingDate.getMonth(),
                        startingDate.getDate(),
                        startingDate.getHours(),
                        startingDate.getMinutes() + 32
                    )
                    emitAtDateTime(inactivityThresholdLater)

                    expect(sessionManager['_getSessionId']()[1]).not.toEqual(startingSessionId)
                    expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(2)
                })

                it('sends a full snapshot if the session is rotated because max time has passed', () => {
                    const startingSessionId = sessionManager['_getSessionId']()[1]
                    emitAtDateTime(startingDate)
                    emitAtDateTime(
                        new Date(
                            startingDate.getFullYear(),
                            startingDate.getMonth(),
                            startingDate.getDate(),
                            startingDate.getHours(),
                            startingDate.getMinutes() + 1
                        )
                    )

                    const moreThanADayLater = new Date(
                        startingDate.getFullYear(),
                        startingDate.getMonth(),
                        startingDate.getDate() + 1,
                        startingDate.getHours() + 1
                    )
                    emitAtDateTime(moreThanADayLater)

                    expect(sessionManager['_getSessionId']()[1]).not.toEqual(startingSessionId)
                    expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(2)
                })
            })
        })
    })

    describe('idle timeouts', () => {
        let startingTimestamp = -1

        function emitInactiveEvent(activityTimestamp: number, expectIdle: boolean = false) {
            const snapshotEvent = {
                event: 123,
                type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
                data: {
                    source: 0,
                },
                timestamp: activityTimestamp,
            }
            _emit(snapshotEvent)
            expect(sessionRecording['isIdle']).toEqual(expectIdle)
            return snapshotEvent
        }

        function emitActiveEvent(activityTimestamp: number) {
            const snapshotEvent = {
                event: 123,
                type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
                data: {
                    source: 1,
                },
                timestamp: activityTimestamp,
            }
            _emit(snapshotEvent)
            expect(sessionRecording['isIdle']).toEqual(false)
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(activityTimestamp)
            return snapshotEvent
        }

        beforeEach(() => {
            sessionRecording.startRecordingIfEnabled()
            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            expect(sessionRecording['status']).toEqual('active')

            startingTimestamp = sessionRecording['_lastActivityTimestamp']
            expect(startingTimestamp).toBeGreaterThan(0)

            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(0)

            // the buffer starts out empty
            expect(sessionRecording['buffer']).toEqual({
                data: [],
                sessionId: null,
                size: 0,
                windowId: null,
            })

            // options will have been emitted
            expect(_addCustomEvent).toHaveBeenCalled()
            _addCustomEvent.mockClear()
        })

        it("enters idle state within one session if the activity is non-user generated and there's no activity for (RECORDING_IDLE_ACTIVITY_TIMEOUT_MS) 5 minutes", () => {
            const firstActivityTimestamp = startingTimestamp + 100
            const secondActivityTimestamp = startingTimestamp + 200
            const thirdActivityTimestamp = startingTimestamp + RECORDING_IDLE_ACTIVITY_TIMEOUT_MS + 1000
            const fourthActivityTimestamp = startingTimestamp + RECORDING_IDLE_ACTIVITY_TIMEOUT_MS + 2000

            const firstSnapshotEvent = emitActiveEvent(firstActivityTimestamp)
            // event was active so activity timestamp is updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // after the first emit the buffer has been initialised but not flushed
            const firstSessionId = sessionRecording['sessionId']
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), firstSnapshotEvent],
                sessionId: firstSessionId,
                size: 88,
                windowId: expect.any(String),
            })

            // the session id generator returns a fixed value, but we want it to rotate in part of this test
            sessionIdGeneratorMock.mockClear()
            const rotatedSessionId = 'rotated-session-id'
            sessionIdGeneratorMock.mockImplementation(() => rotatedSessionId)

            const secondSnapshot = emitInactiveEvent(secondActivityTimestamp, false)
            // event was not active so activity timestamp is not updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // the second snapshot remains buffered in memory
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), firstSnapshotEvent, secondSnapshot],
                sessionId: firstSessionId,
                size: 156,
                windowId: expect.any(String),
            })

            // this triggers idle state and isn't a user interaction so does not take a full snapshot
            emitInactiveEvent(thirdActivityTimestamp, true)
            expect(_addCustomEvent).toHaveBeenCalledWith('sessionIdle', {
                reason: 'user inactivity',
                threshold: 300000,
                timeSinceLastActive: 300900,
            })
            // event was not active so activity timestamp is not updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // the custom event doesn't show here since there's not a real rrweb to emit it
            expect(sessionRecording['buffer']).toEqual({
                data: [
                    createFullSnapshot(),
                    firstSnapshotEvent,
                    secondSnapshot,
                    // the third snapshot is dropped since it switches the session to idle
                ],
                sessionId: firstSessionId,
                size: 156,
                windowId: expect.any(String),
            })

            // this triggers exit from idle state _and_ is a user interaction, so we take a full snapshot

            const fourthSnapshot = emitActiveEvent(fourthActivityTimestamp)
            expect(_addCustomEvent).toHaveBeenCalledWith('sessionNoLongerIdle', {
                reason: 'user activity',
                type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
            })
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(fourthActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(2)

            // the fourth snapshot should not trigger a flush because the session id has not changed...
            expect(sessionRecording['buffer']).toEqual({
                // as we return from idle we will capture a full snapshot _before_ the fourth snapshot
                data: [createFullSnapshot(), firstSnapshotEvent, secondSnapshot, createFullSnapshot(), fourthSnapshot],
                sessionId: firstSessionId,
                size: 244,
                windowId: expect.any(String),
            })

            // because not enough time passed while idle we still have the same session id at the end of this sequence
            const endingSessionId = sessionRecording['sessionId']
            expect(endingSessionId).toEqual(firstSessionId)
        })

        it('rotates session if idle for (MAX_SESSION_IDLE_TIMEOUT) 30 minutes', () => {
            const firstActivityTimestamp = startingTimestamp + 100
            const secondActivityTimestamp = startingTimestamp + 200
            const thirdActivityTimestamp = sessionManager['_sessionTimeoutMs'] + startingTimestamp + 1
            const fourthActivityTimestamp = sessionManager['_sessionTimeoutMs'] + startingTimestamp + 1000

            const firstSnapshotEvent = emitActiveEvent(firstActivityTimestamp)
            // event was active so activity timestamp is updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // after the first emit the buffer has been initialised but not flushed
            const firstSessionId = sessionRecording['sessionId']
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), firstSnapshotEvent],
                sessionId: firstSessionId,
                size: 88,
                windowId: expect.any(String),
            })

            // the session id generator returns a fixed value, but we want it to rotate in part of this test
            sessionIdGeneratorMock.mockClear()
            const rotatedSessionId = 'rotated-session-id'
            sessionIdGeneratorMock.mockImplementation(() => rotatedSessionId)

            const secondSnapshot = emitInactiveEvent(secondActivityTimestamp, false)
            // event was not active so activity timestamp is not updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // the second snapshot remains buffered in memory
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), firstSnapshotEvent, secondSnapshot],
                sessionId: firstSessionId,
                size: 156,
                windowId: expect.any(String),
            })

            // this triggers idle state and isn't a user interaction so does not take a full snapshot

            emitInactiveEvent(thirdActivityTimestamp, true)
            expect(_addCustomEvent).toHaveBeenCalledWith('sessionIdle', {
                reason: 'user inactivity',
                threshold: 300000,
                timeSinceLastActive: 1799901,
            })
            // event was not active so activity timestamp is not updated
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(firstActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(1)

            // the third snapshot is dropped since it switches the session to idle
            // the custom event doesn't show here since there's not a real rrweb to emit it
            expect(sessionRecording['buffer']).toEqual({
                data: [
                    createFullSnapshot(),
                    firstSnapshotEvent,
                    secondSnapshot,
                    // the third snapshot is dropped since it switches the session to idle
                ],
                sessionId: firstSessionId,
                size: 156,
                windowId: expect.any(String),
            })

            // at this point nothing has caused the session to be flushed to the backend
            expect(posthog.capture).not.toHaveBeenCalled()

            // this triggers exit from idle state _and_ is a user interaction, so we take a full snapshot

            const fourthSnapshot = emitActiveEvent(fourthActivityTimestamp)
            expect(_addCustomEvent).toHaveBeenCalledWith('sessionNoLongerIdle', {
                reason: 'user activity',
                type: INCREMENTAL_SNAPSHOT_EVENT_TYPE,
            })
            expect(sessionRecording['_lastActivityTimestamp']).toEqual(fourthActivityTimestamp)
            expect(assignableWindow.rrwebRecord.takeFullSnapshot).toHaveBeenCalledTimes(2)

            // the fourth snapshot causes the session id to change
            expect(sessionIdGeneratorMock).toHaveBeenCalledTimes(1)
            const endingSessionId = sessionRecording['sessionId']
            expect(endingSessionId).toEqual(rotatedSessionId)

            // the buffer is flushed, and a full snapshot is taken
            expect(posthog.capture).toHaveBeenCalledWith(
                '$snapshot',
                {
                    $snapshot_data: [createFullSnapshot(), firstSnapshotEvent, secondSnapshot],
                    $session_id: firstSessionId,
                    $snapshot_bytes: 156,
                    $window_id: expect.any(String),
                },
                {
                    _batchKey: 'recordings',
                    _metrics: { rrweb_full_snapshot: false },
                    _noTruncate: true,
                    endpoint: '/s/',
                    method: 'POST',
                }
            )
            expect(sessionRecording['buffer']).toEqual({
                data: [createFullSnapshot(), fourthSnapshot],
                sessionId: rotatedSessionId,
                size: 88,
                windowId: expect.any(String),
            })
        })
    })

    describe('linked flags', () => {
        it('stores the linked flag on decide response', () => {
            expect(sessionRecording['_linkedFlag']).toEqual(null)
            expect(sessionRecording['_linkedFlagSeen']).toEqual(false)

            sessionRecording.afterDecideResponse(
                makeDecideResponse({ sessionRecording: { endpoint: '/s/', linkedFlag: 'the-flag-key' } })
            )

            expect(sessionRecording['_linkedFlag']).toEqual('the-flag-key')
            expect(sessionRecording['_linkedFlagSeen']).toEqual(false)
            expect(sessionRecording['status']).toEqual('buffering')

            expect(onFeatureFlagsCallback).not.toBeNull()

            onFeatureFlagsCallback?.(['the-flag-key'])
            expect(sessionRecording['_linkedFlagSeen']).toEqual(true)
            expect(sessionRecording['status']).toEqual('active')

            onFeatureFlagsCallback?.(['different', 'keys'])
            expect(sessionRecording['_linkedFlagSeen']).toEqual(false)
            expect(sessionRecording['status']).toEqual('buffering')
        })
    })

    describe('buffering minimum duration', () => {
        it('can report no duration when no data', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('buffering')
            expect(sessionRecording['sessionDuration']).toBe(null)
        })

        it('can report zero duration', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('buffering')
            const { sessionStartTimestamp } = sessionManager.checkAndGetSessionAndWindowId(true)
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp }))
            expect(sessionRecording['sessionDuration']).toBe(0)
        })

        it('can report a duration', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('buffering')
            const { sessionStartTimestamp } = sessionManager.checkAndGetSessionAndWindowId(true)
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp + 100 }))
            expect(sessionRecording['sessionDuration']).toBe(100)
        })

        it('starts with an undefined minimum duration', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['_minimumDuration']).toBe(null)
        })

        it('can set minimum duration from decide response', () => {
            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { minimumDurationMilliseconds: 1500 },
                })
            )
            expect(sessionRecording['_minimumDuration']).toBe(1500)
        })

        it('does not flush if below the minimum duration', () => {
            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { minimumDurationMilliseconds: 1500 },
                })
            )
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('active')
            const { sessionStartTimestamp } = sessionManager.checkAndGetSessionAndWindowId(true)
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp + 100 }))
            expect(sessionRecording['sessionDuration']).toBe(100)
            expect(sessionRecording['_minimumDuration']).toBe(1500)

            expect(sessionRecording['buffer']?.data.length).toBe(2) // full snapshot and the emitted incremental event
            // call the private method to avoid waiting for the timer
            sessionRecording['_flushBuffer']()

            expect(posthog.capture).not.toHaveBeenCalled()
        })

        it('does flush if session duration is negative', () => {
            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { minimumDurationMilliseconds: 1500 },
                })
            )
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('active')
            const { sessionStartTimestamp } = sessionManager.checkAndGetSessionAndWindowId(true)

            // if we have some data in the buffer and the buffer has a session id but then the session id changes
            // then the session duration will be negative, and we will never flush the buffer
            // this setup isn't quite that but does simulate the behaviour closely enough
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp - 1000 }))

            expect(sessionRecording['sessionDuration']).toBe(-1000)
            expect(sessionRecording['_minimumDuration']).toBe(1500)

            expect(sessionRecording['buffer']?.data.length).toBe(2) // full snapshot and the emitted incremental event
            // call the private method to avoid waiting for the timer
            sessionRecording['_flushBuffer']()

            expect(posthog.capture).toHaveBeenCalled()
        })

        it('does not stay buffering after the minimum duration', () => {
            sessionRecording.afterDecideResponse(
                makeDecideResponse({
                    sessionRecording: { minimumDurationMilliseconds: 1500 },
                })
            )
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['status']).toBe('active')
            const { sessionStartTimestamp } = sessionManager.checkAndGetSessionAndWindowId(true)
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp + 100 }))
            expect(sessionRecording['sessionDuration']).toBe(100)
            expect(sessionRecording['_minimumDuration']).toBe(1500)

            expect(sessionRecording['buffer']?.data.length).toBe(2) // full snapshot and the emitted incremental event
            // call the private method to avoid waiting for the timer
            sessionRecording['_flushBuffer']()

            expect(posthog.capture).not.toHaveBeenCalled()

            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp + 1501 }))

            expect(sessionRecording['buffer']?.data.length).toBe(3) // full snapshot and two emitted incremental events
            // call the private method to avoid waiting for the timer
            sessionRecording['_flushBuffer']()

            expect(posthog.capture).toHaveBeenCalled()
            expect(sessionRecording['buffer']?.data.length).toBe(undefined)
            expect(sessionRecording['sessionDuration']).toBe(null)
            _emit(createIncrementalSnapshot({ data: { source: 1 }, timestamp: sessionStartTimestamp + 1502 }))
            expect(sessionRecording['buffer']?.data.length).toBe(1)
            expect(sessionRecording['sessionDuration']).toBe(1502)
            // call the private method to avoid waiting for the timer
            sessionRecording['_flushBuffer']()

            expect(posthog.capture).toHaveBeenCalled()
            expect(sessionRecording['buffer']?.data.length).toBe(undefined)
        })
    })

    describe('when rrweb is not available', () => {
        beforeEach(() => {
            sessionRecording.afterDecideResponse(makeDecideResponse({ sessionRecording: { endpoint: '/s/' } }))
            sessionRecording.startRecordingIfEnabled()
            expect(loadScript).toHaveBeenCalled()

            // fake that rrweb is not available
            sessionRecording['rrwebRecord'] = undefined

            expect(sessionRecording['queuedRRWebEvents']).toHaveLength(0)

            sessionRecording['_tryAddCustomEvent']('test', { test: 'test' })
        })

        it('queues events', () => {
            expect(sessionRecording['queuedRRWebEvents']).toHaveLength(1)
        })

        it('limits the queue of events', () => {
            expect(sessionRecording['queuedRRWebEvents']).toHaveLength(1)

            for (let i = 0; i < 100; i++) {
                sessionRecording['_tryAddCustomEvent']('test', { test: 'test' })
            }

            expect(sessionRecording['queuedRRWebEvents']).toHaveLength(10)
        })

        it('processes the queue when rrweb is available again', () => {
            // fake that rrweb is available again
            sessionRecording['rrwebRecord'] = assignableWindow.rrwebRecord

            _emit(createIncrementalSnapshot({ data: { source: 1 } }))

            expect(sessionRecording['queuedRRWebEvents']).toHaveLength(0)
            expect(sessionRecording['rrwebRecord']).not.toBeUndefined()
        })
    })

    describe('scheduled full snapshots', () => {
        it('starts out unscheduled', () => {
            expect(sessionRecording['_fullSnapshotTimer']).toBe(undefined)
        })

        it('schedules a snapshot on start', () => {
            sessionRecording.startRecordingIfEnabled()
            expect(sessionRecording['_fullSnapshotTimer']).not.toBe(undefined)
        })

        it('reschedules a snapshot, when we take a full snapshot', () => {
            sessionRecording.startRecordingIfEnabled()
            const startTimer = sessionRecording['_fullSnapshotTimer']

            _emit(createFullSnapshot())

            expect(sessionRecording['_fullSnapshotTimer']).not.toBe(undefined)
            expect(sessionRecording['_fullSnapshotTimer']).not.toBe(startTimer)
        })
    })
})
