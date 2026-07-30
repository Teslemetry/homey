// Stand-in for the real "homey" app SDK package, which only resolves to
// usable classes inside the actual Homey runtime. Test-only.
// oxlint-disable max-classes-per-file -- one file mirrors the SDK's several base classes
class Device {}
class Driver {}
class App {}

export default { Device, Driver, App };
