import {createRelay} from "../../../apps/relay/src/worker/handler.ts";
export {Room} from "../../../apps/relay/src/room/room.ts";
export {Stats} from "../../../apps/relay/src/stats/stats.ts";
export default {
  fetch(request,env,ctx) {
    if(new URL(request.url).pathname==="/_probe")return new Response("pibot-probe-ready");
    // This entry is never the deploy target. The public request cannot select a fetch destination.
    return createRelay((url,init)=>{
      if(url!=="https://exp.host/--/api/v2/push/send")throw new Error("unexpected_upstream");
      return fetch(env.FAKE_EXPO_URL,init);
    }).fetch(request,env,ctx);
  }
};
