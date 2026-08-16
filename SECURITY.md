# Security

## Reporting

Report security vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/xikhar/persona/security/advisories/new).
Do not disclose a suspected vulnerability in a public issue, discussion, or
pull request before it has been reviewed.

## Data boundary

Persona's automatic and selected-application listeners calculate a numeric
output level in memory. They do not capture the microphone, write audio to
disk, transcribe it, or send it over the network. Source discovery exposes only
bounded display names and executable or stream identity to Persona's sandboxed
Settings renderer; command-line arguments are not exposed there. A selected
source identity is persisted only in Persona's local settings.

The integration server binds only to `127.0.0.1`, rejects non-loopback `Host`
headers, restricts browser origins, and limits request bodies. Its event API
accepts only normalized state, level, animation, and expression hold/release
events. An expression hold names an action from the same validated local
catalog and resolves to that action's configured expression, so it carries no
free-form expression value, and a held expression is released on a timeout and
on configuration changes rather than persisting indefinitely. Its MCP API exposes
only bounded animation, window, and status operations. Animation names are
validated against the current local catalog before playback. The server cannot
execute commands or access arbitrary files.

The loopback MCP endpoint does not require authentication, so other processes
running on the same computer can invoke those visual controls. Tools that
handle sensitive data or broader system access must not be added without a
separate authorization design.

The renderer is sandboxed with context isolation and no Node.js integration. A
restrictive content security policy is applied, renderer popups are denied, and
navigation outside the local renderer entry is blocked. The avatar and Settings
windows share one preload, so settings changes and VRoid Hub operations are
additionally rejected unless the request comes from the Settings window.

Imported VRM and VRMA files are copied into Persona's per-user application-data
directory. They are available to the sandboxed renderer only through a local
protocol that accepts IDs already recorded by Persona; arbitrary filesystem
paths are rejected. Persona does not upload or expose custom media files.
Configured action names, descriptions, and trigger scenarios are intentionally
available to connected local MCP clients so they can discover and select
animations.

## Supported versions

Until the first public release, only the current source revision is supported.
