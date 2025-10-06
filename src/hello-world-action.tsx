import type {RecordAction} from "attio/client"
import {showDialog} from "attio/client"

import {HelloWorldDialog} from "./hello-world-dialog"

export const recordAction: RecordAction = {
    id: "telegram",
    label: "telegram",
    onTrigger: async ({recordId}) => {
        showDialog({
            title: "telegram",
            Dialog: () => {
                // This is a React component. It can use hooks and render other components.
                return <HelloWorldDialog recordId={recordId} />
            },
        })
    },
}
