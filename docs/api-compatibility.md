# API compatibility

The reference is tscircuit/jlcsearch commit `ba23a0a`. Its renderer, table/filter
definitions, helper functions, and MIT notice are retained in this repository.
The 59 homepage tiles have the same paths, names and ordering. TI branding,
product links and supplier data are specific to this service.

All requests read D1. No request fetches or queues supplier data. List pages
show every stored match without pagination; the explicit `limit` on `/api/search`
is supported for programmatic clients. Historical TI-specific URLs remain valid.

## Category endpoints

Each route supports HTML, `.json`, `?json=true` and JSON content negotiation.
Numeric operators, tolerance, wavelength ranges/aliases, Boolean values, and
custom switch/processor/display filters follow the reference contracts.

| Path | JSON key | Query parameters |
| --- | --- | --- |
| `/categories/list` | `categories` | `category_name` |
| `/footprint_index/list` | `footprints` |  |
| `/resistors/list` | `resistors` | `package`, `is_basic`, `is_preferred`, `resistance` |
| `/resistor_arrays/list` | `resistor_arrays` | `package`, `resistance`, `number_of_resistors` |
| `/capacitors/list` | `capacitors` | `package`, `is_basic`, `is_preferred`, `capacitance` |
| `/potentiometers/list` | `potentiometers` | `package`, `max_resistance` |
| `/headers/list` | `headers` | `pitch`, `num_pins`, `gender`, `is_right_angle` |
| `/barrel_jacks/list` | `barrel_jacks` | `package`, `mounting_style`, `orientation`, `inside_diameter_mm`, `outside_diameter_mm`, `current_rating_min`, `voltage_rating_min`, `num_pins`, `is_basic`, `is_preferred` |
| `/dimm_connectors/list` | `dimm_connectors` | `package`, `ddr_standard`, `num_pins`, `pitch`, `height_mm`, `mounting_type`, `is_right_angle`, `is_basic`, `is_preferred` |
| `/drams/list` | `drams` | `package`, `memory_type`, `memory_size_mbit`, `clock_frequency_min_mhz`, `is_basic`, `is_preferred` |
| `/psrams/list` | `psrams` | `package`, `interface_type`, `memory_size_mbit`, `clock_frequency_min_mhz`, `is_basic`, `is_preferred` |
| `/sodimm_connectors/list` | `sodimm_connectors` | `package`, `ddr_standard`, `num_pins`, `pitch`, `height_mm`, `mounting_type`, `is_right_angle`, `is_basic`, `is_preferred` |
| `/micro_usb_connectors/list` | `micro_usb_connectors` | `package`, `connector_type`, `usb_standard`, `mounting_style`, `number_of_contacts`, `gender`, `is_basic`, `is_preferred` |
| `/usb_c_connectors/list` | `usb_c_connectors` | `package`, `mounting_style`, `gender` |
| `/pcie_m2_connectors/list` | `pcie_m2_connectors` | `key` |
| `/fpc_connectors/list` | `fpc_connectors` | `pitch_mm`, `number_of_contacts` |
| `/jst_connectors/list` | `jst_connectors` | `package`, `num_pins`, `pitch_mm` |
| `/wire_to_board_connectors/list` | `wire_to_board_connectors` | `package`, `num_pins`, `pitch_mm`, `gender` |
| `/spring_clamp_terminal_blocks/list` | `spring_clamp_terminal_blocks` | `pitch`, `pins` |
| `/battery_holders/list` | `battery_holders` | `package`, `battery_type` |
| `/ble_modules/list` | `ble_modules` | `package`, `bluetooth_version`, `core_processor`, `antenna_type`, `has_uart`, `has_i2c`, `has_spi`, `has_usb` |
| `/ble_chips/list` | `ble_chips` | `package`, `bluetooth_version`, `core_processor`, `has_uart`, `has_i2c`, `has_spi`, `has_usb` |
| `/leds/list` | `leds` | `package`, `color` |
| `/adcs/list` | `adcs` | `package`, `resolution_bits`, `num_channels` |
| `/analog_multiplexers/list` | `multiplexers` | `package`, `num_channels` |
| `/analog_switches/list` | `switches` | `package`, `channels` |
| `/io_expanders/list` | `io_expanders` | `package`, `num_gpios` |
| `/gyroscopes/list` | `gyroscopes` | `package`, `axes` |
| `/accelerometers/list` | `accelerometers` | `package`, `axes` |
| `/gas_sensors/list` | `gas_sensors` | `package`, `sensor_type` |
| `/hdmi_ports/list` | `hdmi_ports` | `package`, `mounting_style`, `orientation`, `gender`, `number_of_pins`, `is_basic`, `is_preferred` |
| `/microphones/list` | `microphones` | `package`, `microphone_type` |
| `/diodes/list` | `diodes` | `package`, `diode_type` |
| `/photo_diodes/list` | `photo_diodes` | `package`, `wavelength`, `peak_distance_max`, `excluded_peak_bands`, `reverse_voltage_min`, `dark_current_max`, `is_basic`, `is_preferred` |
| `/dacs/list` | `dacs` | `package`, `resolution_bits`, `num_channels` |
| `/wifi_modules/list` | `wifi_modules` | `package`, `antenna_type` |
| `/microcontrollers/list` | `microcontrollers` | `package`, `core`, `flash_min`, `ram_min` |
| `/arm_processors/list` | `arm_processors` | `package`, `flash_min`, `ram_min`, `interface` |
| `/risc_v_processors/list` | `risc_v_processors` | `package`, `flash_min`, `ram_min`, `interface` |
| `/linux_capable_processors/list` | `linux_capable_processors` | `package`, `manufacturer`, `chip_family`, `architecture`, `cpu_core`, `is_basic`, `is_preferred` |
| `/fpgas/list` | `fpgas` | `package`, `type` |
| `/npu_chips/list` | `npu_chips` | `package`, `manufacturer`, `chip_family`, `npu_name`, `performance_min_tops`, `is_basic`, `is_preferred` |
| `/voltage_regulators/list` | `regulators` | `package`, `output_type` |
| `/ldos/list` | `ldos` | `package`, `output_type`, `output_voltage` |
| `/boost_converters/list` | `boost_converters` | `package`, `output_voltage_min`, `output_voltage_max` |
| `/buck_boost_converters/list` | `buck_boost_converters` | `package` |
| `/led_drivers/list` | `led_drivers` | `package`, `channel_count` |
| `/mosfets/list` | `mosfets` | `package`, `drain_source_voltage_min`, `drain_source_voltage_max`, `continuous_drain_current_min`, `continuous_drain_current_max`, `gate_threshold_voltage_min`, `gate_threshold_voltage_max`, `power_dissipation_min`, `power_dissipation_max`, `mounting_style` |
| `/led_with_ic/list` | `leds_with_ic` | `package`, `color`, `protocol` |
| `/led_dot_matrix_display/list` | `led_dot_matrix_displays` | `package`, `color` |
| `/oled_display/list` | `oled_displays` | `package`, `protocol` |
| `/led_segment_display/list` | `led_segment_displays` | `package`, `color`, `type` |
| `/lcd_display/list` | `lcd_displays` | `package`, `display_type` |
| `/lcd_drivers/list` | `lcd_drivers` | `package`, `max_resolution`, `is_basic`, `is_preferred` |
| `/tft_display_drivers/list` | `tft_display_drivers` | `package`, `driver_type`, `max_resolution`, `is_basic`, `is_preferred` |
| `/switches/list` | `switches` | `package`, `switch_type`, `circuit`, `pin_count` |
| `/relays/list` | `relays` | `package`, `relay_type`, `coil_voltage` |
| `/fuses/list` | `fuses` | `package`, `current_rating` |
| `/bjt_transistors/list` | `bjt_transistors` | `package` |

## Other endpoints

- `/components/list`: `search`, `subcategory_name`, `package`, `is_basic`, `is_preferred`; returns `components`.
- `/api/search`: `q`, `subcategory_name`, `package`, `is_basic`, `is_preferred`, `limit`; returns `components`.
- `/_d1/health` and `/health`: database/service status.
- `/api/footprinter_strings/:lcsc`: validates an optional C prefix and positive numeric ID; returns 404 because TI data has no LCSC/footprinter mapping.
- `/api/easyeda_components/:lcsc`: validates the same ID; returns `component_not_found` with null CAD fields. It never calls EasyEDA.
- `cachebust=1` or `cachebust=true`: sets `cache-control: no-store` and `x-cache-bust: 1`.

## Data boundaries

Category names are a pinned taxonomy snapshot; no JLC part records are imported.
TI product families are mapped to the shared routes and subcategory filters.
Unmapped categories have empty results. The parts index is incomplete and grows
through bounded scheduled requests to TI.

`lcsc`, `is_basic`, and `is_preferred` are null because TI does not supply these
values. Unknown electrical ratings remain null; missing metadata is never
invented to make a filter match. Part identities and product links remain TI.
The API search response retains `ti_product_number` and `supplier_part_number`
for existing TI consumers. Store pricing and inventory are snapshots, not
guaranteed live availability.

## Updating the reference

Review upstream changes to `cf-proxy/src/render.ts`, `handlers/index.ts`,
`d1-routes.ts`, `components.ts`, `search.ts`, and the derived-table schemas.
Update the vendored contracts and independently captured
`test/fixtures/jlc/reference.json`, then run the parity suite. It checks every
homepage tile, category route, JSON key, form parameter, full-category filtering,
unit conversion, and the absence of public upstream requests.

### Taxonomy snapshot coverage

The snapshot contains all 93 top-level category names and all 938 category/subcategory
pairs, verified with the same distinct-name query used by JLCSearch's Categories
endpoint. It was read directly through D1 because eight public directory requests
hit the source service's CPU limit. No part records were copied.
