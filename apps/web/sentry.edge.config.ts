import * as Sentry from "@sentry/nextjs";
import { sharedSentryInit } from "./sentry.shared-config";

Sentry.init(sharedSentryInit);
