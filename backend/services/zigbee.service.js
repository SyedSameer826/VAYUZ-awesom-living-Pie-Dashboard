import { exec } from "child_process";

export const enablePairing = () => {
  return new Promise((resolve, reject) => {
    exec(
      `mosquitto_pub -t zigbee2mqtt/bridge/request/permit_join -m '{"time":60}'`,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
};
