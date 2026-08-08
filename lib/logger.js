import pino from 'pino'
import pretty from 'pino-pretty'

const level = process.env.LOG_LEVEL || 'info'
const isDev = process.env.NODE_ENV !== 'production'

const stream = isDev && process.env.LOG_PRETTY !== '0'
  ? pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss.l',
    singleLine: true
  })
  : undefined

export const logger = pino({
  level,
  base: { service: 'stashernews', env: process.env.NODE_ENV || 'development' }
}, stream)

function emit (method, first, second) {
  if (first instanceof Error) return logger[method]({ err: first })
  if (first !== null && typeof first === 'object') {
    if (typeof second === 'string') return logger[method](first, second)
    return logger[method](first)
  }
  if (second instanceof Error) return logger[method]({ err: second }, first)
  if (second !== undefined) return logger[method]({ data: second }, first)
  return logger[method](first)
}

export const logInfo = (first, second) => emit('info', first, second)
export const logWarn = (first, second) => emit('warn', first, second)
export const logError = (first, second) => emit('error', first, second)

export default logger
