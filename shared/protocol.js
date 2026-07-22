(function exposeProtocol(root, factory) {
  const protocol = factory();
  if (typeof module === "object" && module.exports) module.exports = protocol;
  else root.DigitalTwinProtocol = protocol;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const VERSION = 1;
  const ROLES = Object.freeze({ DISPLAY: "display", CONTROLLER: "controller" });

  const COMMANDS = Object.freeze({
    CAMERA_INPUT: "camera.input",
    CAMERA_RESET: "camera.reset",
    CITY_SELECT: "city.select",
    CITY_CLEAR: "city.clear",
    TIMELINE_FRAME_SET: "timeline.frame.set",
    PLAYBACK_SET: "playback.set",
    EARTH_ROTATION_SET: "earth.rotation.set",
    WEATHER_VISIBLE_SET: "weather.visible.set",
    WEATHER_SOURCE_SET: "weather.source.set",
    WEATHER_LAYER_SET: "weather.layer.set",
    EARTH_DAY_NIGHT_SET: "earth.dayNight.set",
  });

  function clampUnit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-1, Math.min(1, number)) : 0;
  }

  function makeCameraInput(pan, tilt, zoom, sequence) {
    return {
      type: COMMANDS.CAMERA_INPUT,
      pan: clampUnit(pan),
      tilt: clampUnit(tilt),
      zoom: clampUnit(zoom),
      sequence: Number.isSafeInteger(sequence) ? sequence : 0,
    };
  }

  return Object.freeze({ VERSION, ROLES, COMMANDS, clampUnit, makeCameraInput });
}));
