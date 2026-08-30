// Display label of one event: the args-derived override (event kind,
// ExternalInterface target) when there is one, else the kind's name.

import { ProfileModel } from "./model";
import { FrameData } from "./frameData";
import { activityName } from "./categories";

export function activityLabelOf(model: ProfileModel, data: FrameData, index: number): string {
  return data.labelBySeq.get(model.seq[index]) ?? activityName(model.kinds[model.kindIds[index]]);
}
