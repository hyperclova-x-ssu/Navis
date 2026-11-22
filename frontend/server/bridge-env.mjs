export function bridgeOptionsFromEnv(env) {
  return {
    apiKey: env.CLOVASTUDIO_API_KEY,
    baseUrl: env.CLOVASTUDIO_BASE_URL,
    model: env.CLOVASTUDIO_MODEL,
    agentMode: env.NAVIS_AGENT_MODE,
    agentModel: env.NAVIS_AGENT_MODEL,
    // Keep the live model in the default path during answer-quality evaluation.
    agentDirect: env.NAVIS_AGENT_DIRECT === '1',
    ...(env.NAVIS_SSE_HEARTBEAT_MS !== undefined && { heartbeatMs: Number(env.NAVIS_SSE_HEARTBEAT_MS) }),
    // Per-minute chat allowances (turns per session, model tokens per store). An unusable value is ignored by createBridge, which keeps its default.
    ...(env.NAVIS_AGENT_WINDOW_TURNS !== undefined && { agentWindowTurns: Number(env.NAVIS_AGENT_WINDOW_TURNS) }),
    ...(env.NAVIS_AGENT_WINDOW_TOKENS !== undefined && { agentWindowTokens: Number(env.NAVIS_AGENT_WINDOW_TOKENS) }),
    ...(env.NAVIS_AGENT_CLASSIFY === '0' && { agentClassify: false }),
    allowedOrigins: env.NAVIS_ALLOWED_ORIGINS,
    widgets: {
      mode: env.NAVIS_WIDGET_MODE,
      sendEnabled: env.NAVIS_REPLY_SEND_ENABLED,
      testTargets: env.NAVIS_REPLY_TEST_TARGETS,
      sens: {
        serviceId: env.SENS_SMS_SERVICE_ID,
        accessKey: env.NCP_APIGW_KEY_ID,
        secretKey: env.NCP_APIGW_KEY,
        senderNumber: env.SENS_SMS_SENDER_NUMBER,
      },
    },
  };
}
