function buildHookDiagnostics(hookStatus, eventService, lastEventAt) {
  const clients = hookStatus && hookStatus.clients ? Object.values(hookStatus.clients) : [];
  const readyClients = clients.filter((client) => client.status === "installed").length;
  let mode = "process_scan";
  if (clients.length && readyClients === clients.length) mode = "hook";
  else if (readyClients > 0) mode = "hybrid";

  const eventTimestamp = Number(lastEventAt);
  return {
    lastEventAt: Number.isFinite(eventTimestamp) && eventTimestamp > 0 ? eventTimestamp : null,
    eventService: {
      status: eventService && eventService.status === "running" ? "running" : "stopped",
      ...(Number.isInteger(eventService && eventService.port) ? { port: eventService.port } : {}),
    },
    mode,
  };
}

module.exports = { buildHookDiagnostics };
