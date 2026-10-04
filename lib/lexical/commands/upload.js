import { createCommand } from 'lexical'

// The editor's file-upload command, defined here (repo convention: commands
// live in lib/lexical/commands/) so lightweight plugins — the addendum upload
// blocker — can consume it without importing the full upload plugin and its
// fee/FileUpload module graph.
export const SN_UPLOAD_FILES_COMMAND = createCommand('SN_UPLOAD_FILES_COMMAND')
