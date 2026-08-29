// PLACEHOLDER — real blink implementation lands in Phase 4 (board bring-up).
// For now this only needs to exist so the project loader can resolve it.

module top (
    input  logic clk,
    output logic led
);
    assign led = clk;
endmodule
