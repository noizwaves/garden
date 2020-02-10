/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { includes } from "lodash"
import { registerCleanupFunction, uuidv4 } from "../util/util"
import { GardenEvents, GardenEventName, EventBus, loggerEventNames } from "../events"
import { LogEntryMetadata, LogEntry } from "../logger/log-entry"
import { chainMessages } from "../logger/renderers"
import { got } from "../util/http"

export type StreamEvent = {
  name: GardenEventName
  payload: GardenEvents[GardenEventName]
  timestamp: Date
}

export interface LogEntryEvent {
  key: string
  parentKey: string | null
  revision: number
  msg: string | string[]
  timestamp: Date
  data?: any
  section?: string
  metadata?: LogEntryMetadata
}

export function formatForEventStream(entry: LogEntry): LogEntryEvent {
  const { section, data } = entry.getMessageState()
  const { key, revision } = entry
  const parentKey = entry.parent ? entry.parent.key : null
  const metadata = entry.getMetadata()
  const msg = chainMessages(entry.getMessageStates() || [])
  const timestamp = new Date()
  return { key, parentKey, revision, msg, data, metadata, section, timestamp }
}

export const FLUSH_INTERVAL_MSEC = 1000
export const MAX_BATCH_SIZE = 100

/**
 * Buffers events and log entries and periodically POSTs them to the platform.
 */
export class BufferedEventStream {
  private log: LogEntry
  private eventBus: EventBus
  public sessionId: string
  private platformUrl: string
  private clientAuthToken: string

  private uid: string

  /**
   * For testing.
   *
   * Should e.g. be set on BufferedEventStream instance before running commands in unit tests.
   */
  public flushEventsTestHandler: null | ((events: StreamEvent[]) => void)
  public flushLogEntriesTestHandler: null | ((logEntries: LogEntryEvent[]) => void)

  private intervalId: NodeJS.Timer | null
  private bufferedEvents: StreamEvent[]
  private bufferedLogEntries: LogEntryEvent[]

  constructor(log: LogEntry, sessionId) {
    this.log = log
    this.sessionId = sessionId
    this.flushEventsTestHandler = null
    this.flushLogEntriesTestHandler = null
    this.uid = uuidv4()
    this.bufferedEvents = []
    this.bufferedLogEntries = []
  }

  connect(eventBus: EventBus, clientAuthToken: string, platformUrl: string) {
    this.clientAuthToken = clientAuthToken
    this.platformUrl = platformUrl

    if (!this.intervalId) {
      this.startInterval()
    }

    // Expects previously connected event busses to have removed all their listeners by this point.
    if (this.eventBus && this.eventBus.listeners.length > 0) {
      this.log.error("BufferedEventStream: Previously connected eventBus still has registered listeners.")
    }
    this.eventBus = eventBus

    this.eventBus.onAny(this.handleEvent)
  }

  startInterval() {
    this.intervalId = setInterval(() => {
      this.flushBuffered({ flushAll: false })
    }, FLUSH_INTERVAL_MSEC)

    registerCleanupFunction("flushAllBufferedEventsAndLogEntries", () => {
      this.close()
    })
  }

  handleEvent(name, payload) {
    if (includes(loggerEventNames, name)) {
      this.streamLogEntry(payload as LogEntryEvent)
    } else {
      this.streamEvent(name as GardenEventName, payload)
    }
  }

  close() {
    console.log("--------")
    console.log("--------")
    console.log("--------")
    console.log("bufferedEventStream.close() for uid", this.uid)
    console.log("--------")
    console.log("--------")
    console.log("--------")
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.flushBuffered({ flushAll: true })
  }

  streamEvent<T extends GardenEventName>(name: T, payload: GardenEvents[T]) {
    this.bufferedEvents.push({
      name,
      payload,
      timestamp: new Date(),
    })
  }

  streamLogEntry(logEntry: LogEntryEvent) {
    this.bufferedLogEntries.push(logEntry)
  }

  flushEvents(events: StreamEvent[]) {
    got.post(`${this.platformUrl}/events`, {
      json: {
        events,
        clientAuthToken: this.clientAuthToken,
        sessionId: this.sessionId,
      },
    })
  }

  flushLogEntries(logEntries: LogEntryEvent[]) {
    got.post(`${this.platformUrl}/log-entries`, {
      json: {
        logEntries,
        clientAuthToken: this.clientAuthToken,
        sessionId: this.sessionId,
      },
    })
  }

  flushBuffered({ flushAll = false }) {
    if (!this.clientAuthToken || !this.platformUrl) {
      return
    }
    console.log(`flushBuffered${flushAll ? " all = true" : ""}: instance uid:${this.uid}, sessionId: ${this.sessionId}`)
    const eventsToFlush = this.bufferedEvents.splice(0, flushAll ? this.bufferedEvents.length : MAX_BATCH_SIZE)

    if (eventsToFlush.length > 0) {
      // this.flushEventsTestHandler ? this.flushEventsTestHandler(eventsToFlush) : this.flushEvents(eventsToFlush)
    }

    const logEntryFlushCount = flushAll ? this.bufferedLogEntries.length : MAX_BATCH_SIZE - eventsToFlush.length
    const logEntriesToFlush = this.bufferedLogEntries.splice(0, logEntryFlushCount)

    if (logEntriesToFlush.length > 0) {
      // this.flushLogEntriesTestHandler
      //   ? this.flushLogEntriesTestHandler(logEntriesToFlush)
      //   : this.flushLogEntries(logEntriesToFlush)
    }
  }
}
