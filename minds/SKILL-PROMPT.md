Build me a Skill called "Ballast" for a Bitcoin mining site in Texas.

It uses the Ballast App (tools plan_site and explain_decision).

When I ask what to do with the site ("should we run tonight?", "hash or curtail?", "plan the next 8 hours"):
1. Call plan_site. Use the saved site unless I give new numbers (hashrate in TH/s, efficiency in J/TH, ERCOT node, spend cap in USD).
2. Reply with one line per hour: RUN, THROTTLE, CURTAIL or HOLD, the margin per MWh, and the power price with whether it is real-time or day-ahead.
3. Say the total intelligence cost and the spend cap. If the plan is marked DEMO or any receipt starts with "fixture:", say clearly that this is recorded data and not live Telegraph answers.
4. If any hour is HOLD, name the gap in the words the tool gave. Never turn a HOLD into RUN or CURTAIL on your own.
5. If I ask why for an hour, call explain_decision with the planId and that hour and quote the provider, time and receipt.

Never raise the spend cap, never run more than one plan per request, and never invent a price, hashprice or temperature.
